import path from "node:path";
import type { WebpackOverrideFn } from "@remotion/bundler";

// One React for the film and the app's components it imports (../apps/web),
// and the app's icon set from the repository's node_modules.
export const webpackOverride: WebpackOverrideFn = (config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      ...(config.resolve?.alias ?? {}),
      react: path.resolve(process.cwd(), "node_modules/react"),
      "react-dom": path.resolve(process.cwd(), "node_modules/react-dom"),
      "lucide-react": path.resolve(process.cwd(), "../node_modules/lucide-react"),
      // tokens.css loads the fonts from the app's root (/fonts/…).
      "/fonts": path.resolve(process.cwd(), "public/fonts"),
    },
  },
});
