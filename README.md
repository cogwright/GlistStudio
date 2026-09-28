# Glist Studio

Glist Studio is a lightweight desktop IDE for Glist Engine projects, built with Electron and TypeScript.

The current Windows setup expects Glist Engine and its toolchain under `C:\dev\glist`.

## Features

- Project explorer with file and folder operations, context menus, and copy/paste
- Tabbed C/C++ editor powered by Monaco
- C++ code intelligence from clangd: diagnostics, completion, hover, signature help, go to definition, references, rename, quick fixes, formatting, outline, and header/source switching (Alt+O)
- Save, build, run, and stop commands with live output
- Automatic CMake source-list updates when files are created, renamed, or removed
- C++ class generation with matching header and source files
- Project creation from the bundled GlistApp, GlistConsoleApp, and GlistGUIApp templates
- English and Turkish interface languages (English by default)

## C++ code intelligence

Opening a project starts [clangd](https://clangd.llvm.org/). It is looked up on `PATH`; on Windows the Glist `clang64\bin` folder is searched first. Without clangd the editor still works, with syntax highlighting only.

clangd reads the compile flags from `_build/Release/compile_commands.json`, which the build writes. Until a project has been built once, clangd cannot find the engine headers; it restarts on its own after that first build. Definitions in GlistEngine and its plugins open read-only.

## Development

Install dependencies and start the IDE:

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

Use the IDE from a browser, for example on another machine:

```powershell
npm run web
```

This builds the renderer as a web page, runs the same backend in Node, and prints a link with an access token. The server listens on `127.0.0.1:8787`; reach it from elsewhere through a tunnel or reverse proxy. Anyone with the link can build and run code on the host, so share it accordingly. Open Project asks for a folder path on the host, and showing items in the system explorer is not available. Settings come from environment variables:

- `GLIST_STUDIO_PORT`: port to listen on
- `GLIST_STUDIO_PROJECTS`: folder for new projects, and the default when opening one
- `GLIST_STUDIO_TOKEN`: a fixed access token instead of a new one per run

Build a Windows application folder:

```powershell
npm run package
```

## Project layout

- `src/index.ts`: Electron main process with the window, dialogs, and IPC
- `src/studio.ts`: Filesystem access and build commands, independent of Electron
- `src/api.ts`: The renderer API and the IPC channel for each call
- `src/preload.ts`: Restricted bridge between the renderer and main process
- `src/clangd-process.ts` and `src/clangd.ts`: clangd process and the language client that feeds Monaco
- `src/web/` and `scripts/web.ts`: Browser version of the API and the server behind `npm run web`
- `src/renderer.ts`: Editor and interface behavior
- `src/index.html` and `src/index.css`: Interface structure and styling
- `src/localization.ts`: English and Turkish interface text
- `glistapp-template/`: Bundled new-project templates

Node.js access is disabled in the renderer. Filesystem and process actions go through the preload bridge.
