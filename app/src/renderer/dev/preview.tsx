import type {ReactNode} from "react";
import {createRoot} from "react-dom/client";
import {App} from "../App";
import {Boundary} from "../components/Boundary";
import {routeHash} from "../model/route";
import "../styles.css";
import type {Scenario} from "./mockBridge";
import {createMockBridge, isScenario, SCENARIOS} from "./mockBridge";

/**
 * The dev preview: the REAL App, mounted in a browser against an in-memory bridge, so the four
 * screens can be looked at without an Electron window and without arranging ten machine states.
 * Built only by `node scripts/build.mjs --preview`, never imported by main.tsx, and never part of
 * the normal build output — the production bundle's module-graph guard would fail if it were.
 *
 * Open app/dist-preview/index.html?scenario=<name>. The names are `SCENARIOS`.
 */
const DEFAULT: Scenario = "home-off";

const asked = new URLSearchParams(window.location.search).get("scenario");
const scenario: Scenario = isScenario(asked) ? asked : DEFAULT;

window.clave = createMockBridge(scenario);
// A Linux scenario routes as its name without the "linux-" in front.
const route = scenario.replace(/^linux-/, "");
window.location.hash = route.startsWith("onboarding") || route === "signin"
  ? ""
  : route === "settings" ? routeHash("settings")
    : route.startsWith("review") ? routeHash("review")
      : routeHash("home");

/** A row of links across the top of the page, so every scenario is one click away. */
function Picker(): ReactNode {
  return (
    <nav className="picker">
      {SCENARIOS.map((name) => (
        <a key={name} className={name === scenario ? "picker-here" : undefined} href={`?scenario=${name}`}>{name}</a>
      ))}
    </nav>
  );
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <>
      <Picker />
      <Boundary>
        <App />
      </Boundary>
    </>
  );
}
