// Page-side shim, built to dist/shim.js as one IIFE and injected with
// Page.addScriptToEvaluateOnNewDocument before any page script runs.
import { install } from './install.ts';

install(globalThis);
