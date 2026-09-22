/**
 * `import "./styles.css"` is how esbuild is told to bundle the stylesheet and emit it as main.css,
 * which index.html links. It imports no values, so TypeScript needs nothing from it but permission
 * to see the specifier.
 */
declare module "*.css";
