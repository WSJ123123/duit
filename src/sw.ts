import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

// Declares the injection point for the precache manifest to TypeScript.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  // Build assets (JS/CSS chunks, public/ files) — the app shell — are
  // precached via the injected manifest.
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // defaultCache includes a NetworkFirst "pages" strategy for same-origin
  // documents and RSC payloads, so /quick (a dynamic, authed page) is served
  // from cache when offline after it has been visited once.
  runtimeCaching: defaultCache,
});

serwist.addEventListeners();
