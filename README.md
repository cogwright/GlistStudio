# Glist Studio

Glist Studio is a lightweight desktop IDE for Glist Engine projects, built with Electron and TypeScript.

![Glist Studio with a small Glist project open: the explorer with the engine under Dependencies, C++ code in Glist Engine's style colored by clangd, and a finished build in the Output panel](docs/images/editor.png)

## Features

- Project explorer: files and folders are made, renamed, copied, moved by dragging and deleted, several at a time, and what is dropped from the system's file manager is copied in. The engine and the plugins the project uses are under Dependencies, and work the same way
- C/C++ editor powered by Monaco, with code intelligence from clangd: diagnostics, completion, go to definition, references, rename and quick fixes. A tab dragged to the side, or Split Right, puts two editors side by side
- Formatting in Glist Engine's own style (tabs, braces on the same line, `if(` without a space) or by the project's `.clang-format`: Reformat File for a whole file, and on saving only the lines changed, with `#include`s left where they are. Settings, under General, chooses the style
- Search Everywhere (Shift twice), Find in Files (Ctrl+Shift+F) and a command palette (Ctrl+Shift+P)
- Images open as pictures, fitted to their tab
- Build, run and stop with live output, where file locations open the file at that line; the program's arguments and environment variables are set in Settings
- With Show all targets on in Settings, a list beside Run of every CMake target, the engine's and plugins' too, as CLion has; Build, Run and Debug use the one chosen
- A debugger with breakpoints, stepping, variables and the call stack. While paused, pointing at a variable shows its value, with structs and pointers to open as a tree, and a crash stops on the line where it happened, naming the signal or exception
- A terminal in the project folder, or in any folder from the explorer's Show in menu, with the same tools on `PATH` as builds
- Git, off until turned on, laid out as in JetBrains IDEs: a Commit view, diffs in the editor, the log and its graph, branches, remotes, stashes, blame and conflict resolution, also for the engine's and plugins' own repositories, with pushed commits and protected branches kept from being rewritten
- Coding agents (Claude Code, Codex, Gemini CLI, Antigravity) in an Agent tab, off until turned on
- A Plugins view listing GlistPlugins' plugins, and AITIAL's OpenWhiz: one click installs one into `glistplugins`, another adds it to the project, and clicking it shows its README. Updates from where it came from are offered as they come, keeping any work of your own on a stash or a branch. gipDebug is left out, since the studio installs its own debugger
- An Engine view: the engine the project uses, its branch and commit, and GlistEngine's new commits, brought in the way plugins' are. An engine or plugin cloned from your own fork gets the original as `upstream`, to update from
- Automatic CMake source-list updates when files are created, renamed, or removed
- CMake configures again on its own when a CMake file changes, so code intelligence follows new files and plugins without a build
- C++ class generation with matching header and source files
- New projects from the bundled GlistApp, GlistConsoleApp and GlistGUIApp templates
- Installing Glist Engine itself, with its own installer, when it is missing
- English, Turkish and French, with git's and the compilers' messages in the same language where they have it; themes including imported VS Code themes, font choices, and a scale setting up to 300% for projectors

## Installing

Each release carries a universal `.dmg` for macOS, a setup `.exe` for Windows on x64 and arm64, and an AppImage for Linux on x86_64 and aarch64.

- macOS: the app is signed with a Developer ID and notarized by Apple, so it opens like any other. Drag it from the disk image into Applications, and start it from there: run from the disk image, it cannot update itself.
- Windows: the installer is not signed yet, so SmartScreen shows "Windows protected your PC" once; choose More info, then Run anyway.
- Linux: make the AppImage executable (`chmod +x`) and run it. It runs natively on Wayland when the session sets `XDG_SESSION_TYPE=wayland`, as Hyprland does; elsewhere pass `--ozone-platform=wayland`. On tiling compositors such as Hyprland, sway and i3 the window has no buttons of its own.

After that, Glist Studio updates itself from the published releases: it downloads a new version in the background, checks it against GitHub's checksum, and installs it when it restarts. Settings, under Updates, turns this off, or takes previews too: builds of every change, before a release. Where it cannot replace itself, such as an app in a folder this user cannot write to, it links to the release instead.

Glist Studio expects Glist where its install scripts put it: `C:\dev\glist` on Windows, with the toolchain in `zbin`, and `~/dev/glist` on macOS and Linux. When it is not there, the studio offers to run the current installer from [GlistEngine/InstallScripts](https://github.com/GlistEngine/InstallScripts). The studio keeps its settings in `GlistStudio` in that folder. Agents installed from Settings go there too, with their own Node.js, and change nothing else on the computer.

## Other tools it uses

- **clangd** for code intelligence, from `PATH`, and on Windows from Glist's `clang64\bin` first. It reads the compile flags a build writes, so it finds the engine headers once the project has been built. Without clangd the editor only highlights syntax.
- **A debugger** that speaks the Debug Adapter Protocol:
  - macOS: `lldb-dap` from Xcode or its command line tools.
  - Linux: `lldb-dap` from LLVM (also named `lldb-vscode`), or GDB 14 or newer.
  - Windows: Glist's tools have none, so Settings, under Debugger, installs GDB from MSYS2, the source of Glist's compilers, with every file checked against a checksum pinned in `src/debugger-packages.json`. It is the only debugger used on Windows: others found there, such as the gipDebug plugin's, cannot find their own files. If it does not start, the studio offers to install it again.
- **Git**, only once it is turned on: Xcode's command line tools on macOS, the `git` package on Linux, and [Git for Windows](https://git-scm.com/).

Builds, runs, the debugger, clangd and the terminal get a `PATH` of the studio's own, not the one it was started with: Glist's tools and CMake from `zbin`, Windows' own folders and Git for Windows on Windows; Homebrew's, the system's and Xcode's folders on macOS; the system's folders on Linux. On Windows, the DLL folders of the plugins a project uses, `libs\bin` and `prebuilts\bin`, are added at the end, as those plugins' READMEs ask Eclipse users to do by hand. Settings, under PATH, lists every folder in the order they are searched, and takes more folders, which go last. Agents are still looked for on the computer's own `PATH`, and the Glist installer runs with it.

Passwords, for the Glist installer or a git remote, and an SSH key's passphrase, are asked for by a dialog of the system's own, never typed into the studio. On Linux that dialog is zenity, kdialog or ssh-askpass; without one, the installer asks in its terminal instead. On Windows, Git Credential Manager asks for HTTPS logins, and a PowerShell dialog for an SSH key's passphrase. GitHub takes a personal access token, not the account password.

## Development

```powershell
npm ci
npm start
```

Run the checks:

```powershell
npm test
npm run lint
npx tsc --noEmit
```

`npm run web` serves the IDE to a browser instead: it runs the same backend in Node and prints a link with an access token. It listens on `127.0.0.1:8787`; reach it from elsewhere through a tunnel or reverse proxy. Anyone with the link can build and run code on the host, so share it accordingly. It reads these environment variables:

- `GLIST_STUDIO_PORT`: port to listen on
- `GLIST_STUDIO_PROJECTS`: the `myglistapps` folder to use while no project is open
- `GLIST_STUDIO_TOKEN`: a fixed access token instead of a new one per run

`GLIST_STUDIO_HOME`, in either build, puts the studio's own folder (its settings, debugger and agents) elsewhere, which keeps trials away from your own.

`npm run make` builds the installers for the machine you are on, unsigned. `.github/workflows/release.yml` builds every installer on GitHub: a tag such as `v0.2.0` drafts a release to check and publish, and every push to `main` publishes a prerelease numbered after the last release, such as `0.0.7-dev.5`, for those who take previews, and removes the one before it, keeping its tag. The macOS app is signed and notarized there when the repository has the signing secrets the workflow names.

## Project layout

- `src/index.ts`: the Electron main process
- `src/studio.ts`: the backend (files, builds, processes), independent of Electron; `src/git-service.ts` runs git for it
- `src/api.ts`: the calls the interface can make, carried over IPC by `src/preload.ts` in Electron and over a WebSocket by `src/web/` and `scripts/web.ts` in the browser
- `src/renderer.ts`, `src/index.html` and `src/index.css`: the interface; the other files in `src/` are its parts, named after what they do
- `src/locales/`: every word the studio shows, one JSON file per language (`en.json`, `tr.json`, `fr.json`); a language is added by translating `en.json` and naming it in `src/languages.ts`, and `tests/locales.test.mjs` checks it has every word with the same placeholders
- `glistapp-template/`: the new-project templates
- `tests/`: the unit tests `npm test` runs, most with jiti, since they import the TypeScript sources

Node.js access is disabled in the interface; files and processes are reached only through the API.

## License

Apache License 2.0, see `LICENSE`. The icons are from Codicons and Seti, and the fonts on Windows and Linux are Inter and JetBrains Mono, see `THIRD_PARTY_NOTICES.md`.
