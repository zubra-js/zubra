// Turbopack takes webpack-style loaders: zubra's turns each `.zb` import into the element and,
// as the default export, a React (client) component. In the server's build it also registers
// how to render the component, so the React wrapper puts each shadow-DOM component's
// declarative shadow root into the server's HTML: the cards show before JavaScript.
const loader = '@zubra/unplugin/loader';
// A hosted demo (HOSTED_DEMO=1, lib/hosted.js) reads at most 16 KiB of a Server Action's request.
// It's decided when Next builds and starts, so deploy/next-conference sets it for both.
const hosted = process.env.HOSTED_DEMO === '1';

export default {
  // The server renders with @zubra/compiler at request time, from node_modules.
  serverExternalPackages: ['@zubra/compiler'],
  // The Docker image runs Next's standalone server (NEXT_OUTPUT=standalone); `next start` the rest.
  // The app has no images to optimise, so it leaves out sharp (half the image's node_modules).
  ...(process.env.NEXT_OUTPUT === 'standalone' && {
    output: 'standalone',
    outputFileTracingExcludes: { '*': ['node_modules/sharp/**', 'node_modules/@img/**'] },
  }),
  // The hosted mode's test builds beside the other's (test/hosted-app.test.js).
  ...(process.env.NEXT_DIST_DIR && { distDir: process.env.NEXT_DIST_DIR }),
  ...(hosted && { experimental: { serverActions: { bodySizeLimit: '16kb' } } }),
  turbopack: {
    rules: {
      '*.zb': [
        { condition: 'browser', loaders: [loader], as: '*.js' },
        { condition: { not: 'browser' }, loaders: [{ loader, options: { server: true } }], as: '*.js' },
      ],
    },
  },
};
