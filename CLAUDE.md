# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **Visual Studio Code** (Code - OSS) repository — a large-scale TypeScript/Electron application. Version 1.110.0.

## Build & Development Commands

### Initial Setup
```bash
npm install       # Also installs extension dependencies (including claude-code)
npm run electron  # Download Electron
```

### Building
- **Incremental watch build**: `npm run watch` (runs client transpile + client watch + extensions watch in parallel)
- **Compile**: `npm run compile` (full gulp compile)
- **Compile web**: `npm run compile-web`

### Running
- **Desktop**: `./scripts/code.sh` (macOS/Linux) or `scripts/code.bat` (Windows)
- **Web server**: `./scripts/code-server.sh` or `./scripts/code-web.sh`
- **CLI**: `./scripts/code-cli.sh`

### Testing
- **Unit tests (Electron)**: `./scripts/test.sh` (or `scripts/test.bat`)
  - Filter tests: `./scripts/test.sh --grep "pattern"`
- **Unit tests (browser)**: `npm run test-browser`
- **Unit tests (Node)**: `npm run test-node`
- **Integration tests**: `./scripts/test-integration.sh` (or `scripts/test-integration.bat`)
  - Integration tests end with `.integrationTest.ts` or live under `/extensions/`
- **Build script tests**: `npm run test-build-scripts`

### Linting & Validation
- **ESLint**: `npm run eslint`
- **Stylelint**: `npm run stylelint`
- **Layer validation**: `npm run valid-layers-check`
- **Hygiene check**: `npm run hygiene`
- **Precommit hook**: `npm run precommit`

## Architecture

### Layered Module System (strict import order)
```
base → platform → editor → workbench
```
Each layer may only import from layers to its left. Use `npm run valid-layers-check` to verify.

- **`src/vs/base/`** — Foundation: data structures, DOM utilities, async helpers, platform abstractions
- **`src/vs/platform/`** — Platform services: DI infrastructure, file service, configuration, storage, etc.
- **`src/vs/editor/`** — Monaco text editor: core editor model, view, controllers, language services
- **`src/vs/workbench/`** — Full IDE shell:
  - `browser/` — Core workbench layout, parts (sidebar, panel, editor area)
  - `services/` — Service implementations (extensions, search, debug, etc.)
  - `contrib/` — Feature modules (git, terminal, debug, search, chat, etc.)
  - `api/` — Extension host bridge, VS Code Extension API implementation
- **`src/vs/code/`** — Electron main process
- **`src/vs/server/`** — Remote server (VS Code Server)

### Key Patterns

**Dependency Injection**: Services are injected via constructor parameters decorated with service identifiers. Non-service parameters come before service parameters.

**Contribution Pattern**: Features register themselves through contribution points and registries rather than being directly wired.

**Disposables**: All resources must be properly disposed. Use `DisposableStore`, `MutableDisposable`, or `DisposableMap`. Register disposables immediately after creation. For methods called repeatedly, return `IDisposable` instead of registering on the class.

**Localization**: All user-facing strings use `nls.localize()` with double quotes. Use placeholders (`{0}`) instead of string concatenation.

### Test Structure
- Unit tests live alongside source in `src/vs/**/test/` directories
- Integration tests use `.integrationTest.ts` suffix
- Extension tests live under `extensions/*/src/test/`
- Use `describe`/`test` (TDD style via mocha). Prefer `assert.deepStrictEqual` snapshots over many small assertions.

## Coding Conventions

- **Indentation**: Tabs, not spaces
- **Naming**: PascalCase for types/enums, camelCase for functions/properties/variables
- **Strings**: Single quotes for code strings, double quotes for user-facing localized strings
- **Functions**: Prefer `export function` over `export const =>`  at top-level scope
- **Arrow params**: Only parenthesize when necessary: `x => x + x` not `(x) => x + x`
- **Types**: Avoid `any`/`unknown`. Don't export types unless shared across components.
- **Copyright**: All files must include the Microsoft copyright header
- **UI labels**: Title Case for commands/buttons/menus (don't capitalize short prepositions)
- **Tooltips**: Use `IHoverService` rather than native tooltips
- **Editors**: Use `IEditorService` to open editors, not `IEditorGroupsService.activeGroup.openEditor`
- **File watchers**: Prefer correlated file watchers via `fileService.createWatcher`
