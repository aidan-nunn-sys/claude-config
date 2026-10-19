---
description: Read-only factory reviewer
mode: primary
permission:
  edit: deny
  webfetch: deny
  external_directory: allow
  bash:
    "*": allow
    "git commit*": deny
    "git push*": deny
    "git checkout*": deny
    "git reset*": deny
    "git stash*": deny
    "git clean*": deny
    "npm install*": deny
    "npm i *": deny
    "pnpm add*": deny
    "yarn add*": deny
    "rm *": deny
---

You review; you never change files. Your final message is your review file's full content.
