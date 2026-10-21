set -euo pipefail
runtime="${CE_CONTAINER_DATA:?}/ce-native-codex"
for file in "$runtime/node" "$runtime/runner"; do
  test -f "$file" && test ! -L "$file"
  test "$(stat -c %u "$file")" = "$(id -u)"
  test "$(stat -c %h "$file")" = 1
done
printf '%s  %s\n' e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb "$runtime/node" | sha256sum --check --status
printf '%s  %s\n' 9a820c17865fa825d04db416818679a9d63bd72e50835c396f496e5684626c9c "$runtime/runner" | sha256sum --check --status
test "$("$runtime/node" --version)" = v24.22.1
home="$RUNNER_TEMP/ce-codex-home"
mkdir -p "$home"
sudo -n unshare --net -- runuser --user "$(id -un)" -- env -i \
  PATH="$runtime:$PATH" HOME="$home" CONTEXT_ENGINE_NATIVE_CODEX="$runtime/runner" \
  "$runtime/node" --test --test-concurrency=1 setup/native-codex.test.ts
