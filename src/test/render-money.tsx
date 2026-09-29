import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MoneyProvider } from "@/components/Money";

/**
 * Plan 9 masked-state component tests: static markup of `el` inside a
 * `MoneyProvider` in the given state (the house has no DOM environment).
 * A provider-less render is plain `renderToStaticMarkup` — the shown default.
 * JSX (hence `.tsx`): `createElement` would need a cast or a `children` prop.
 */
export const renderMasked = (el: ReactElement): string =>
  renderToStaticMarkup(<MoneyProvider initialHidden>{el}</MoneyProvider>);

export const renderShown = (el: ReactElement): string =>
  renderToStaticMarkup(<MoneyProvider initialHidden={false}>{el}</MoneyProvider>);
