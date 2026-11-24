// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server";
import { fromEnv, NOTICE } from "./lib/hosted.js";

// A public demo (HOSTED_DEMO=1) says so on every page. It is outside #app, so Solid, which mounts
// there, renders and hydrates the page the same with it or without.
const notice = fromEnv() ? NOTICE : null;

export default createHandler(() => (
  <StartServer
    document={({ assets, children, scripts }) => (
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <link rel="icon" href="/favicon.ico" />
          {assets}
        </head>
        <body>
          {notice && <p class="demo-notice">{notice}</p>}
          <div id="app">{children}</div>
          {scripts}
        </body>
      </html>
    )}
  />
));
