#!/bin/zsh
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v node >/dev/null 2>&1; then
  node scripts/start.mjs
elif [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
  export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
  node scripts/start.mjs
else
  echo 'Установите Node.js LTS, затем запустите этот файл ещё раз.'
fi
echo 'Нажмите Enter, чтобы закрыть окно.'
read
