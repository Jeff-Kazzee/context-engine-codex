// Native Windows primitives. Source authored on Linveo, compiled/tested natively.
// No pathname namespace mutation: children are opened relative to held HANDLEs.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <sddl.h>
#include <node_api.h>
#include <cstddef>
#include <cstring>
#include <cwctype>
#include <iomanip>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr ULONG shareAll = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
constexpr ULONG synchronousNoFollow = 0x20 | 0x00200000;
constexpr ACCESS_MASK inspectAccess = FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
using NtCreate = NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
using NtSet = NTSTATUS(NTAPI*)(HANDLE,PIO_STATUS_BLOCK,PVOID,ULONG,FILE_INFORMATION_CLASS);
using NtFlush = NTSTATUS(NTAPI*)(HANDLE,ULONG,PVOID,ULONG,PIO_STATUS_BLOCK);
using NtRead = NTSTATUS(NTAPI*)(HANDLE,HANDLE,PVOID,PVOID,PIO_STATUS_BLOCK,PVOID,ULONG,PLARGE_INTEGER,PULONG);
using NtWrite = NtRead;
using NtQueryDir = NTSTATUS(NTAPI*)(HANDLE,HANDLE,PVOID,PVOID,PIO_STATUS_BLOCK,PVOID,ULONG,FILE_INFORMATION_CLASS,BOOLEAN,PUNICODE_STRING,BOOLEAN);
using NtError = ULONG(NTAPI*)(NTSTATUS);

struct Failure : std::runtime_error {
  std::string code;
  Failure(std::string c, std::string message) : std::runtime_error(message), code(std::move(c)) {}
};
const char* errorCode(DWORD error) {
  switch (error) {
    case ERROR_FILE_NOT_FOUND: case ERROR_PATH_NOT_FOUND: return "ENOENT";
    case ERROR_FILE_EXISTS: case ERROR_ALREADY_EXISTS: return "EEXIST";
    case ERROR_ACCESS_DENIED: case ERROR_PRIVILEGE_NOT_HELD: return "EACCES";
    case ERROR_INVALID_HANDLE: return "EBADF";
    case ERROR_DIRECTORY: return "ENOTDIR";
    case ERROR_DIR_NOT_EMPTY: return "ENOTEMPTY";
    case ERROR_NOT_SAME_DEVICE: return "EXDEV";
    case ERROR_WRITE_PROTECT: return "EROFS";
    case ERROR_SHARING_VIOLATION: case ERROR_LOCK_VIOLATION: return "EBUSY";
    case ERROR_INVALID_PARAMETER: case ERROR_INVALID_NAME: return "EINVAL";
    default: return "EIO";
  }
}
[[noreturn]] void winFail(const char* operation, DWORD error = GetLastError()) {
  throw Failure(errorCode(error), std::string(operation) + " failed (Win32 " + std::to_string(error) + ")");
}
void require(bool pass, const char* message) { if (!pass) throw Failure("EINVAL", message); }
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
  Handle(const Handle&) = delete;
  HANDLE release() { HANDLE h = value; value = INVALID_HANDLE_VALUE; return h; }
};
struct Local {
  HLOCAL value = nullptr;
  ~Local() { if (value) LocalFree(value); }
};
struct Entry { HANDLE handle; bool directory; bool append; bool enumerated = false; };
struct State {
  NtCreate create;
  NtSet set;
  NtFlush flush;
  NtRead read;
  NtWrite write;
  NtQueryDir queryDir;
  NtError toError;
  std::vector<BYTE> user;
  PSECURITY_DESCRIPTOR security = nullptr;
  std::map<uint32_t, Entry> handles;
  // Outside the signed 32-bit fd range: accidental Node fs calls must refuse.
  uint32_t next = 0x80000000;
  State() {
    HMODULE dll = GetModuleHandleW(L"ntdll.dll");
#define LOAD(field, type, name) field = reinterpret_cast<type>(GetProcAddress(dll, name)); require(field != nullptr, "required native API unavailable")
    LOAD(create,NtCreate,"NtCreateFile"); LOAD(set,NtSet,"NtSetInformationFile");
    LOAD(flush,NtFlush,"NtFlushBuffersFileEx"); LOAD(read,NtRead,"NtReadFile");
    LOAD(write,NtWrite,"NtWriteFile"); LOAD(queryDir,NtQueryDir,"NtQueryDirectoryFile");
    LOAD(toError,NtError,"RtlNtStatusToDosError");
#undef LOAD
    HANDLE rawToken = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&rawToken)) winFail("OpenProcessToken");
    Handle token(rawToken); DWORD count = 0;
    GetTokenInformation(token.value,TokenUser,nullptr,0,&count);
    require(count > 0 && count < 65536, "invalid current-user identity");
    user.resize(count);
    if (!GetTokenInformation(token.value,TokenUser,user.data(),count,&count)) winFail("GetTokenInformation");
    LPWSTR rawSid = nullptr;
    if (!ConvertSidToStringSidW(sid(),&rawSid)) winFail("ConvertSidToStringSid");
    Local sidText; sidText.value = rawSid;
    // OS administrators and SYSTEM already control this ordinary-user process.
    std::wstring dacl = L"O:" + std::wstring(rawSid) + L"D:P(A;OICI;FA;;;" + rawSid + L")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(dacl.c_str(),SDDL_REVISION_1,&security,nullptr)) winFail("private security descriptor");
  }
  ~State() { for (auto& pair : handles) CloseHandle(pair.second.handle); if (security) LocalFree(security); }
  PSID sid() { return reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid; }
  void nt(NTSTATUS status,const char* operation) {
    if (status >= 0) return;
    std::ostringstream message; message << operation << " failed (NTSTATUS 0x" << std::hex << static_cast<ULONG>(status) << ")";
    throw Failure(errorCode(toError(status)),message.str());
  }
  Entry& get(uint32_t id) {
    auto it = handles.find(id);
    if (it == handles.end()) throw Failure("EBADF","unknown or closed backend descriptor");
    return it->second;
  }
  uint32_t keep(Handle& handle,bool directory,bool append = false) {
    require(next != 0, "backend descriptor space exhausted");
    uint32_t id = next++;
    handles.emplace(id,Entry{handle.value,directory,append}); handle.release(); return id;
  }
  Handle open(HANDLE parent,const std::wstring& name,ACCESS_MASK access,ULONG disposition,ULONG kind,bool privateCreate) {
    UNICODE_STRING text{}; text.Buffer = const_cast<PWSTR>(name.data());
    text.Length = static_cast<USHORT>(name.size()*sizeof(WCHAR)); text.MaximumLength = text.Length;
    OBJECT_ATTRIBUTES object{}; object.Length = sizeof(object); object.RootDirectory = parent;
    object.ObjectName = &text; object.Attributes = 0x40; object.SecurityDescriptor = privateCreate ? security : nullptr;
    HANDLE raw = INVALID_HANDLE_VALUE; IO_STATUS_BLOCK io{};
    nt(create(&raw,access,&object,&io,nullptr,FILE_ATTRIBUTE_NORMAL,shareAll,disposition,kind|synchronousNoFollow,nullptr,0),"NtCreateFile");
    return Handle(raw);
  }
};
void wellFormedUtf16(const std::wstring& text) {
  for (size_t i = 0; i < text.size(); ++i) {
    const WCHAR c = text[i];
    if (c >= 0xD800 && c <= 0xDBFF) {
      require(i+1 < text.size() && text[i+1] >= 0xDC00 && text[i+1] <= 0xDFFF,"unpaired UTF-16 high surrogate refused");
      ++i;
    } else require(c < 0xDC00 || c > 0xDFFF,"unpaired UTF-16 low surrogate refused");
  }
}
void component(const std::wstring& name) {
  wellFormedUtf16(name);
  require(!name.empty() && name.size() <= 255 && name != L"." && name != L"..", "invalid Windows path component");
  require(name.back() != L'.' && name.back() != L' ', "ambiguous Windows trailing dot or space");
  for (WCHAR c : name) require(c >= 32 && wcschr(L"\\/:*?\"<>|",c) == nullptr, "invalid Windows path or alternate stream");
  std::wstring stem = name.substr(0,name.find(L'.'));
  for (auto& c : stem) c = static_cast<WCHAR>(towupper(c));
  require(stem != L"CON" && stem != L"PRN" && stem != L"AUX" && stem != L"NUL" && stem != L"CONIN$" && stem != L"CONOUT$", "reserved Windows device name");
  bool port = stem.size() == 4 && (stem.substr(0,3) == L"COM" || stem.substr(0,3) == L"LPT") && ((stem[3] >= L'1' && stem[3] <= L'9') || stem[3] == 0xB9 || stem[3] == 0xB2 || stem[3] == 0xB3);
  require(!port, "reserved Windows port name");
}
FILE_ATTRIBUTE_TAG_INFO attributes(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO value{};
  if (!GetFileInformationByHandleEx(handle,FileAttributeTagInfo,&value,sizeof(value))) winFail("file attributes");
  return value;
}
void noReparse(HANDLE handle) {
  if (attributes(handle).FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) throw Failure("ELOOP","reparse points are refused by the Windows backend");
}
FILE_ID_INFO identity(HANDLE handle) {
  FILE_ID_INFO value{};
  if (!GetFileInformationByHandleEx(handle,FileIdInfo,&value,sizeof(value))) winFail("full file identity");
  return value;
}
bool sameIdentity(HANDLE a,HANDLE b) {
  auto x = identity(a), y = identity(b);
  return x.VolumeSerialNumber == y.VolumeSerialNumber && memcmp(x.FileId.Identifier,y.FileId.Identifier,16) == 0;
}
std::wstring finalPath(HANDLE handle) {
  DWORD size = GetFinalPathNameByHandleW(handle,nullptr,0,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  if (!size || size > 32768) winFail("final file path");
  std::vector<WCHAR> bytes(size+1);
  DWORD count = GetFinalPathNameByHandleW(handle,bytes.data(),static_cast<DWORD>(bytes.size()),FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  if (!count || count >= bytes.size()) winFail("final file path");
  std::wstring path(bytes.data(),count);
  require(path.size() >= 7 && path.substr(0,4) == L"\\\\?\\" && path[5] == L':' && path[6] == L'\\', "non-local canonical file path refused");
  const std::wstring ordinary = path.substr(4);
  for (size_t start = 3; start < ordinary.size();) {
    const size_t end = ordinary.find(L'\\',start);
    component(ordinary.substr(start,end == std::wstring::npos ? end : end-start));
    if (end == std::wstring::npos) break;
    start = end+1;
  }
  return ordinary;
}
bool privateAcl(HANDLE handle,PSID current, bool& owned) {
  PSID owner = nullptr; PACL dacl = nullptr; PSECURITY_DESCRIPTOR raw = nullptr;
  DWORD error = GetSecurityInfo(handle,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,nullptr,&dacl,nullptr,&raw);
  if (error != ERROR_SUCCESS) winFail("file security inspection",error);
  Local descriptor; descriptor.value = raw;
  owned = owner && EqualSid(owner,current);
  SECURITY_DESCRIPTOR_CONTROL control = 0; DWORD revision = 0;
  if (!dacl || !GetSecurityDescriptorControl(raw,&control,&revision) || !(control & SE_DACL_PROTECTED)) return false;
  BYTE system[SECURITY_MAX_SID_SIZE], admins[SECURITY_MAX_SID_SIZE]; DWORD s = sizeof(system), a = sizeof(admins);
  if (!CreateWellKnownSid(WinLocalSystemSid,nullptr,system,&s) || !CreateWellKnownSid(WinBuiltinAdministratorsSid,nullptr,admins,&a)) winFail("well-known SID");
  for (DWORD i = 0; i < dacl->AceCount; ++i) {
    void* rawAce = nullptr; if (!GetAce(dacl,i,&rawAce)) winFail("DACL entry");
    auto* header = static_cast<ACE_HEADER*>(rawAce);
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) return false;
    PSID allowed = &reinterpret_cast<ACCESS_ALLOWED_ACE*>(rawAce)->SidStart;
    if (!IsValidSid(allowed) || (!EqualSid(allowed,current) && !EqualSid(allowed,system) && !EqualSid(allowed,admins))) return false;
  }
  return true;
}
void napiCheck(napi_status status) { if (status != napi_ok) throw Failure("EINVAL","invalid native API argument or response"); }
std::wstring text(napi_env env,napi_value value) {
  size_t count = 0; napiCheck(napi_get_value_string_utf16(env,value,nullptr,0,&count));
  require(count <= 32767, "Windows string exceeds bound");
  std::vector<char16_t> buffer(count+1); napiCheck(napi_get_value_string_utf16(env,value,buffer.data(),buffer.size(),&count));
  return std::wstring(reinterpret_cast<WCHAR*>(buffer.data()),count);
}
uint32_t integer(napi_env env,napi_value value) {
  double number = 0; napiCheck(napi_get_value_double(env,value,&number));
  require(number >= 0 && number <= 0xFFFFFFFF && number == static_cast<uint32_t>(number), "invalid unsigned integer");
  return static_cast<uint32_t>(number);
}
int64_t offset(napi_env env,napi_value value) {
  double number = 0; napiCheck(napi_get_value_double(env,value,&number));
  require(number >= 0 && number <= 9007199254740991.0 && number == static_cast<int64_t>(number), "invalid file offset");
  return static_cast<int64_t>(number);
}
napi_value string(napi_env env,const std::wstring& value) {
  napi_value out; napiCheck(napi_create_string_utf16(env,reinterpret_cast<const char16_t*>(value.data()),value.size(),&out)); return out;
}
napi_value ascii(napi_env env,const std::string& value) {
  napi_value out; napiCheck(napi_create_string_utf8(env,value.c_str(),value.size(),&out)); return out;
}
napi_value number(napi_env env,double value) { napi_value out; napiCheck(napi_create_double(env,value,&out)); return out; }
napi_value boolean(napi_env env,bool value) { napi_value out; napiCheck(napi_get_boolean(env,value,&out)); return out; }
napi_value nil(napi_env env) { napi_value out; napiCheck(napi_get_null(env,&out)); return out; }
void property(napi_env env,napi_value object,const char* name,napi_value value) { napiCheck(napi_set_named_property(env,object,name,value)); }
std::string hex(const void* bytes,size_t count) {
  auto* data = static_cast<const BYTE*>(bytes); std::ostringstream out;
  for (size_t i = 0; i < count; ++i) out << std::hex << std::setw(2) << std::setfill('0') << unsigned(data[i]);
  return out.str();
}
napi_value inspect(napi_env env,State& state,HANDLE handle) {
  auto tag = attributes(handle); auto id = identity(handle); FILE_STANDARD_INFO standard{};
  if (!GetFileInformationByHandleEx(handle,FileStandardInfo,&standard,sizeof(standard))) winFail("file standard metadata");
  require(standard.EndOfFile.QuadPart >= 0 && standard.EndOfFile.QuadPart <= 9007199254740991LL, "file size exceeds exact integer range");
  FILE_BASIC_INFO times{};
  if (!GetFileInformationByHandleEx(handle,FileBasicInfo,&times,sizeof(times))) winFail("file change timestamps");
  bool owned = false; bool privacy = privateAcl(handle,state.sid(),owned);
  napi_value out; napiCheck(napi_create_object(env,&out));
  property(env,out,"dev",ascii(env,"win32-volume:"+hex(&id.VolumeSerialNumber,sizeof(id.VolumeSerialNumber))));
  property(env,out,"ino",ascii(env,"win32-file:"+hex(id.FileId.Identifier,16)));
  property(env,out,"mtime",ascii(env,"win32-filetime:"+std::to_string(times.LastWriteTime.QuadPart)));
  property(env,out,"ctime",ascii(env,"win32-filetime:"+std::to_string(times.ChangeTime.QuadPart)));
  property(env,out,"nlink",number(env,standard.NumberOfLinks));
  property(env,out,"size",number(env,static_cast<double>(standard.EndOfFile.QuadPart)));
  property(env,out,"owner",ascii(env,owned ? "current" : "other"));
  property(env,out,"privateAccess",boolean(env,privacy));
  property(env,out,"directory",boolean(env,standard.Directory != FALSE));
  property(env,out,"reparse",boolean(env,(tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0));
  return out;
}
struct NameInfo { union { BOOLEAN replace; ULONG flags; }; HANDLE parent; ULONG bytes; WCHAR name[1]; };
static_assert(offsetof(NameInfo,parent) == 8 && offsetof(NameInfo,name) == 20,"x64 native name layout required");
void nameOperation(State& state,HANDLE source,HANDLE parent,const std::wstring& name,bool replace,int kind) {
  component(name);
  size_t bytes = sizeof(NameInfo)+name.size()*sizeof(WCHAR);
  std::vector<BYTE> buffer(bytes); auto* info = reinterpret_cast<NameInfo*>(buffer.data());
  if (kind == 65) info->flags = replace ? 3 : 2; else info->replace = replace ? TRUE : FALSE; info->parent = parent; info->bytes = static_cast<ULONG>(name.size()*sizeof(WCHAR));
  memcpy(info->name,name.data(),info->bytes); IO_STATUS_BLOCK io{};
  state.nt(state.set(source,&io,info,static_cast<ULONG>(bytes),static_cast<FILE_INFORMATION_CLASS>(kind)),"anchored namespace publication");
}
Handle reopenWithAccess(HANDLE original,DWORD access) {
  BY_HANDLE_FILE_INFORMATION oldInfo{};
  if (!GetFileInformationByHandle(original,&oldInfo)) winFail("NTFS file index");
  FILE_ID_DESCRIPTOR descriptor{}; descriptor.dwSize = sizeof(descriptor); descriptor.Type = FileIdType;
  descriptor.FileId.HighPart = static_cast<LONG>(oldInfo.nFileIndexHigh); descriptor.FileId.LowPart = oldInfo.nFileIndexLow;
  Handle reopened(OpenFileById(original,&descriptor,access,shareAll,nullptr,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT));
  if (reopened.value == INVALID_HANDLE_VALUE) winFail("same-object write-capable reopen");
  noReparse(reopened.value);
  if (!sameIdentity(original,reopened.value)) throw Failure("EIO","flush handle identity changed; refusing flush");
  return Handle(reopened.release());
}
Handle reopenForFlush(HANDLE original,bool directory) {
  DWORD access = directory ? inspectAccess|FILE_LIST_DIRECTORY|FILE_ADD_FILE|FILE_ADD_SUBDIRECTORY|FILE_TRAVERSE : inspectAccess|FILE_WRITE_DATA;
  return reopenWithAccess(original,access);
}
// FileNamesInformation: native enumeration returns one bounded name per call.
struct NameEntry { ULONG next; ULONG index; ULONG bytes; WCHAR name[1]; };
static_assert(offsetof(NameEntry,name) == 12,"native name enumeration layout required");
napi_value nextName(napi_env env,State& state,Entry& entry) {
  require(entry.directory,"enumeration requires directory"); noReparse(entry.handle);
  std::vector<BYTE> buffer(65536); IO_STATUS_BLOCK io{};
  for (;;) {
    NTSTATUS result = state.queryDir(entry.handle,nullptr,nullptr,nullptr,&io,buffer.data(),static_cast<ULONG>(buffer.size()),static_cast<FILE_INFORMATION_CLASS>(12),TRUE,nullptr,entry.enumerated ? FALSE : TRUE);
    entry.enumerated = true;
    if (static_cast<ULONG>(result) == 0x80000006) return nil(env);
    state.nt(result,"anchored directory enumeration");
    auto* item = reinterpret_cast<NameEntry*>(buffer.data());
    require(io.Information >= offsetof(NameEntry,name) && item->bytes % 2 == 0 && item->bytes <= io.Information - offsetof(NameEntry,name),"malformed directory name");
    std::wstring name(item->name,item->bytes/sizeof(WCHAR));
    if (name == L"." || name == L"..") continue;
    return string(env,name);
  }
}
napi_value dispatch(napi_env env,napi_callback_info info) {
  try {
    size_t argc = 8; napi_value args[8]{}; void* data = nullptr;
    napiCheck(napi_get_cb_info(env,info,&argc,args,nullptr,&data));
    require(argc >= 1,"missing native operation"); auto& state = *static_cast<State*>(data);
    auto op = text(env,args[0]);
    auto arg = [&](size_t index) { require(index < argc,"missing native argument"); return args[index]; };
    auto entry = [&](size_t index) -> Entry& { return state.get(integer(env,arg(index))); };
    auto directoryEntry = [&](size_t index) -> Entry& { auto& dir = entry(index); require(dir.directory,"parent is not a directory"); noReparse(dir.handle); return dir; };
    if (op == L"root") {
      auto path = text(env,arg(1));
      require(path.size() == 3 && iswalpha(path[0]) && path[1] == L':' && path[2] == L'\\',"only local drive roots are supported");
      if (GetDriveTypeW(path.c_str()) != DRIVE_FIXED) throw Failure("CE_UNSUPPORTED_FILESYSTEM","Windows backend requires a fixed local NTFS drive");
      Handle handle(CreateFileW(path.c_str(),inspectAccess|FILE_LIST_DIRECTORY|FILE_TRAVERSE,shareAll,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
      if (handle.value == INVALID_HANDLE_VALUE) winFail("drive root"); noReparse(handle.value);
      WCHAR filesystem[32]{};
      if (!GetVolumeInformationByHandleW(handle.value,nullptr,0,nullptr,nullptr,nullptr,filesystem,32)) winFail("filesystem identity");
      if (wcscmp(filesystem,L"NTFS") != 0) throw Failure("CE_UNSUPPORTED_FILESYSTEM","Windows backend requires verified local NTFS");
      return number(env,state.keep(handle,true));
    }
    if (op == L"reopen-directory") {
      auto& original = directoryEntry(1);
      auto handle = reopenWithAccess(original.handle,inspectAccess|FILE_LIST_DIRECTORY|FILE_TRAVERSE);
      return number(env,state.keep(handle,true));
    }
    if (op == L"dup") {
      auto& from = entry(1); HANDLE raw = INVALID_HANDLE_VALUE;
      if (!DuplicateHandle(GetCurrentProcess(),from.handle,GetCurrentProcess(),&raw,0,FALSE,DUPLICATE_SAME_ACCESS)) winFail("duplicate backend handle");
      Handle handle(raw); return number(env,state.keep(handle,from.directory,from.append));
    }
    if (op == L"open") {
      auto& parent = directoryEntry(1);
      auto name = text(env,arg(2)); component(name); auto intent = text(env,arg(3));
      ACCESS_MASK access = inspectAccess; ULONG disposition = 1, kind = 0x40; bool createPrivate = false, append = false;
      if (intent == L"directory") { access |= FILE_LIST_DIRECTORY|FILE_TRAVERSE; kind = 1; }
      else if (intent == L"inspect") kind = 0;
      else if (intent == L"read") access |= FILE_READ_DATA;
      else if (intent == L"exclusive" || intent == L"exclusive-nofollow") { access |= FILE_WRITE_DATA|FILE_APPEND_DATA; disposition = 2; createPrivate = true; }
      else if (intent == L"append" || intent == L"append-existing") { access |= FILE_WRITE_DATA|FILE_APPEND_DATA; append = true; disposition = intent == L"append" ? 3 : 1; createPrivate = intent == L"append"; }
      else if (intent == L"read-write") access |= FILE_READ_DATA|FILE_WRITE_DATA|FILE_APPEND_DATA;
      else throw Failure("EINVAL","unknown Windows open intent");
      auto handle = state.open(parent.handle,name,access,disposition,kind,createPrivate);
      if (intent != L"inspect") noReparse(handle.value);
      bool directory = (attributes(handle.value).FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      return number(env,state.keep(handle,directory,append));
    }
    if (op == L"close") {
      uint32_t id = integer(env,arg(1)); HANDLE handle = state.get(id).handle;
      // Retire the logical descriptor before close. Never retry an uncertain close.
      state.handles.erase(id); if (!CloseHandle(handle)) winFail("close backend handle"); return nil(env);
    }
    if (op == L"inspect") return inspect(env,state,entry(1).handle);
    if (op == L"path") return string(env,finalPath(entry(1).handle));
    if (op == L"next") return nextName(env,state,entry(1));
    if (op == L"flush") {
      auto& original = entry(1); auto writable = reopenForFlush(original.handle,original.directory);
      IO_STATUS_BLOCK io{}; state.nt(state.flush(writable.value,0,nullptr,0,&io),"file and namespace durability flush"); return nil(env);
    }
    if (op == L"truncate") {
      auto& file = entry(1); noReparse(file.handle); require(!file.directory,"cannot truncate directory");
      FILE_END_OF_FILE_INFO size{}; size.EndOfFile.QuadPart = offset(env,arg(2));
      if (!SetFileInformationByHandle(file.handle,FileEndOfFileInfo,&size,sizeof(size))) winFail("file truncate"); return nil(env);
    }
    if (op == L"read" || op == L"write") {
      auto& file = entry(1); noReparse(file.handle); require(!file.directory,"cannot read or write directory data");
      napi_typedarray_type type; size_t elements = 0, arrayOffset = 0; void* bytes = nullptr; napi_value backing;
      napiCheck(napi_get_typedarray_info(env,arg(2),&type,&elements,&bytes,&backing,&arrayOffset));
      require(type == napi_uint8_array || type == napi_uint8_clamped_array,"byte array required");
      uint32_t start = integer(env,arg(3)), length = integer(env,arg(4));
      require(start <= elements && length <= elements-start,"byte range outside buffer");
      if (length == 0) return number(env,0);
      napi_value position = arg(5); napi_valuetype valueType; napiCheck(napi_typeof(env,position,&valueType));
      LARGE_INTEGER at{}; LARGE_INTEGER* pointer = nullptr;
      if (valueType != napi_null) { at.QuadPart = offset(env,position); pointer = &at; }
      if (op == L"write" && file.append) { at.QuadPart = -1; pointer = &at; }
      LARGE_INTEGER saved{}, zero{};
      const bool restorePosition = valueType != napi_null;
      if (restorePosition && !SetFilePointerEx(file.handle,zero,&saved,FILE_CURRENT)) winFail("capture positioned-I/O cursor");
      IO_STATUS_BLOCK io{};
      NTSTATUS result = (op == L"read" ? state.read : state.write)(file.handle,nullptr,nullptr,nullptr,&io,static_cast<BYTE*>(bytes)+start,length,pointer,nullptr);
      if (restorePosition && !SetFilePointerEx(file.handle,saved,nullptr,FILE_BEGIN)) winFail("restore positioned-I/O cursor");
      if (op == L"read" && static_cast<ULONG>(result) == 0xC0000011) return number(env,0);
      state.nt(result,op == L"read" ? "read opened file" : "write opened file");
      require(io.Information <= length,"invalid native byte count"); return number(env,static_cast<double>(io.Information));
    }
    if (op == L"mkdir") {
      auto& parent = directoryEntry(1);
      auto name = text(env,arg(2)); component(name);
      auto directory = state.open(parent.handle,name,inspectAccess|FILE_LIST_DIRECTORY|FILE_TRAVERSE,2,1,true);
      noReparse(directory.value); return nil(env);
    }
    if (op == L"rename" || op == L"link") {
      auto& parent = directoryEntry(1); auto name = text(env,arg(2)); component(name);
      auto& targetParent = directoryEntry(3); auto targetName = text(env,arg(4)); component(targetName);
      require(parent.directory && targetParent.directory,"namespace parents must be directories");
      auto source = state.open(parent.handle,name,inspectAccess|DELETE,1,op == L"link" ? 0x40 : 0,false); noReparse(source.value);
      nameOperation(state,source.value,targetParent.handle,targetName,op == L"rename",op == L"rename" ? 65 : 11);
      return nil(env);
    }
    if (op == L"unlink" || op == L"rmdir") {
      auto& parent = directoryEntry(1); auto name = text(env,arg(2)); component(name);
      auto target = state.open(parent.handle,name,inspectAccess|DELETE,1,op == L"rmdir" ? 1 : 0x40,false); noReparse(target.value);
      // Delete this opened link, preserving other open data handles. No IGNORE_READONLY flag.
      ULONG flags = 1 | 2; IO_STATUS_BLOCK io{};
      state.nt(state.set(target.value,&io,&flags,sizeof(flags),static_cast<FILE_INFORMATION_CLASS>(64)),"anchored disposition"); return nil(env);
    }
    if (op == L"private") {
      auto& original = entry(1); bool owned = false; privateAcl(original.handle,state.sid(),owned);
      if (!owned) throw Failure("EACCES","refusing to change permissions of another owner's object");
      auto writable = reopenWithAccess(original.handle,READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES|SYNCHRONIZE);
      bool reopenedOwned = false; privateAcl(writable.value,state.sid(),reopenedOwned);
      if (!reopenedOwned) throw Failure("EACCES","owner changed before permission update");
      BOOL present = FALSE, defaulted = FALSE; PACL dacl = nullptr;
      if (!GetSecurityDescriptorDacl(state.security,&present,&dacl,&defaulted) || !present || !dacl) winFail("private DACL template");
      DWORD error = SetSecurityInfo(writable.value,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,nullptr,nullptr,dacl,nullptr);
      if (error != ERROR_SUCCESS) winFail("private DACL update",error);
      bool stillOwned = false;
      if (!privateAcl(writable.value,state.sid(),stillOwned) || !stillOwned) throw Failure("EACCES","private DACL verification failed");
      return nil(env);
    }
    if (op == L"process") {
      DWORD pid = integer(env,arg(1)); require(pid > 0,"invalid process id");
      Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pid));
      if (!process.value || process.value == INVALID_HANDLE_VALUE) return nil(env);
      FILETIME created{},exited{},kernel{},userTime{};
      if (!GetProcessTimes(process.value,&created,&exited,&kernel,&userTime)) return nil(env);
      DWORD wait = WaitForSingleObject(process.value,0); if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) return nil(env);
      ULARGE_INTEGER start{}; start.HighPart = created.dwHighDateTime; start.LowPart = created.dwLowDateTime;
      napi_value out; napiCheck(napi_create_object(env,&out));
      property(env,out,"startMarker",ascii(env,"win32:"+std::to_string(start.QuadPart)));
      property(env,out,"kind",ascii(env,"windows-process")); property(env,out,"alive",boolean(env,wait == WAIT_TIMEOUT)); return out;
    }
    if (op == L"count") return number(env,static_cast<double>(state.handles.size()));
    throw Failure("EINVAL","unknown native backend operation");
  } catch (const Failure& failure) { napi_throw_error(env,failure.code.c_str(),failure.what()); }
    catch (const std::exception& failure) { napi_throw_error(env,"EIO",failure.what()); }
    catch (...) { napi_throw_error(env,"EIO","unknown native backend failure"); }
  return nullptr;
}
void cleanup(void* data) { delete static_cast<State*>(data); }
napi_value initialize(napi_env env,napi_value exports) {
  try {
    auto* state = new State;
    napi_status status = napi_add_env_cleanup_hook(env,cleanup,state);
    if (status != napi_ok) { delete state; napiCheck(status); }
    napi_value call; napiCheck(napi_create_function(env,"call",4,dispatch,state,&call)); property(env,exports,"call",call);
    property(env,exports,"contractVersion",number(env,1)); return exports;
  } catch (const Failure& failure) { napi_throw_error(env,failure.code.c_str(),failure.what()); return nullptr; }
    catch (...) { napi_throw_error(env,"EIO","native backend initialization failed"); return nullptr; }
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME,initialize)
