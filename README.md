# Glist Studio

Glist Studio is a lightweight desktop IDE for Glist Engine projects, built with Electron and TypeScript.

The current Windows setup expects Glist Engine and its toolchain under `C:\dev\glist`.

## Features

- Project explorer with file and folder operations, context menus, and copy/paste
- Tabbed C/C++ editor powered by Monaco
- Save, build, run, and stop commands with live output
- Automatic CMake source-list updates when files are created, renamed, or removed
- C++ class generation with matching header and source files
- Project creation from the bundled GlistApp, GlistConsoleApp, and GlistGUIApp templates
- English and Turkish interface languages (English by default)

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

Build a Windows application folder:

```powershell
npm run package
```

## Project layout

- `src/index.ts`: Electron main process with the window, dialogs, and IPC
- `src/studio.ts`: Filesystem access and build commands, independent of Electron
- `src/api.ts`: The renderer API and the IPC channel for each call
- `src/preload.ts`: Restricted bridge between the renderer and main process
- `src/renderer.ts`: Editor and interface behavior
- `src/index.html` and `src/index.css`: Interface structure and styling
- `src/localization.ts`: English and Turkish interface text
- `glistapp-template/`: Bundled new-project templates

Node.js access is disabled in the renderer. Filesystem and process actions go through the preload bridge.
