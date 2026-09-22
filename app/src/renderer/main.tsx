import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {App} from "./App";
import {Boundary} from "./components/Boundary";
import "./styles.css";

/**
 * The renderer's one entry. The stylesheet is imported here so esbuild emits it as main.css, which
 * index.html links; nothing is fetched at run time, by anything, ever.
 *
 * `Boundary` is outside `App` on purpose: a throw anywhere inside the window — including in the
 * frame itself — shows one sentence and a way to try again, instead of a blank rectangle.
 */
const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <Boundary>
        <App />
      </Boundary>
    </StrictMode>
  );
}
