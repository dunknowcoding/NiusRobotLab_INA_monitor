# NiusRobotLab INA Monitor

[![CI](https://github.com/dunknowcoding/NiusRobotLab_INA_monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/dunknowcoding/NiusRobotLab_INA_monitor/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-00a3e0?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-5b4bff?style=flat-square)](package.json)
[![Electron](https://img.shields.io/badge/Electron-32.x-47848f?style=flat-square)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61dafb?style=flat-square)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square)](https://www.typescriptlang.org/)

A desktop monitoring tool for INA-series power sensors, focused on real-time visualization, serial-device integration, fault-aware analysis, and a debuggable development workflow.

![INA Monitor screenshot](assets/screenshot.JPG)

## Overview

NiusRobotLab INA Monitor is a small monorepo with two packages:

- `@niusrobotlab/ina-monitor-app`: Electron + React desktop application.
- `@niusrobotlab/ina-monitor-core`: shared models, conversion logic, fault detection, and tests.

The application is designed for bench testing and driver validation workflows where you need to connect a live INA device over serial, inspect voltage/current/power traces, and compare that against simulated sources during development.

## Key capabilities

- Real-time charts for voltage, current, and power.
- Multi-source monitoring, including serial inputs and built-in mock sources.
- INA3221-specific multi-channel views with consistent front-end routing.
- Fault-aware monitoring pipeline in the shared core package.
- Electron preload bridge for serial access from the renderer.
- Local GitHub Actions CI for lint, test, and build validation.

## Supported workflow

The UI and supporting protocol are built for INA-series monitoring flows, including common usage with:

- INA219
- INA226
- INA228
- INA3221
- Related devices exposed through the same serial JSONL bridge model

Actual device support depends on the firmware bridge feeding the desktop app.

## Getting started

### Prerequisites

- Node.js 20 or newer recommended
- npm
- Windows, Linux, or macOS

### Install

```bash
git clone https://github.com/dunknowcoding/NiusRobotLab_INA_monitor.git
cd NiusRobotLab_INA_monitor
npm install
```

### Run in development

```bash
npm run dev
```

This starts the Vite renderer and launches the Electron shell after the Electron main/preload bundle has been compiled.

### Build

```bash
npm run build
```

### Run the production app locally

```bash
npm run start:app
```

## Repository layout

```text
.
|- .github/workflows/ci.yml
|- assets/
|- packages/
|  |- ina-monitor-app/
|  \- ina-monitor-core/
|- package.json
|- package-lock.json
\- README.md
```

## Development checks

The repository exposes a small set of top-level commands:

- `npm run lint:ws` -> lint all workspace packages
- `npm test` -> run the core package test suite
- `npm run build` -> build core and app packages

These same checks are used by the GitHub Actions workflow in `.github/workflows/ci.yml`.

## Notes for contributors

- The Electron app expects its preload bundle under `packages/ina-monitor-app/dist-electron/`.
- The desktop app uses a serial bridge contract; unsupported transport-side command assumptions should be avoided in the renderer.
- Repository-local debug artifacts should not be committed.

## License

This project is released under the MIT License. See [LICENSE](LICENSE).
