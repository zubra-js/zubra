import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteLoaderData } from 'react-router';
import { fromEnv, NOTICE } from './lib/hosted.server.js';
import './app.css';

// A hosted demo (HOSTED_DEMO=1) says on every page that its data resets.
export const loader = () => ({ notice: fromEnv() ? NOTICE : null });

export function Layout({ children }) {
  const notice = useRouteLoaderData('root')?.notice;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {notice && <p className="demo-notice">{notice}</p>}
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// A refused request (a hosted demo's 429 or 413, say) keeps the page's layout and a way back.
export function ErrorBoundary({ error }) {
  return (
    <main>
      <h1>{isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : 'Something went wrong'}</h1>
      {error?.status === 429 && <p className="lede">Too many changes from here: try again in a minute.</p>}
      <p><a href="/">Back to the trip</a></p>
    </main>
  );
}
