import './globals.css';
import { fromEnv, NOTICE } from '@/lib/hosted.js';

export const metadata = { title: 'WebConf 2026', description: 'A conference schedule built with Next.js and zubra components.' };

export default function Layout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a href="/" className="brand">WebConf 2026</a>
          <span className="muted">Lisbon · Thu–Fri</span>
        </header>
        {fromEnv() && <p className="demo-notice">{NOTICE}</p>}
        <main>{children}</main>
      </body>
    </html>
  );
}
