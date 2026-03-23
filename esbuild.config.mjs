import esbuild from 'esbuild';

const nodeBuiltins = ['events', 'fs', 'child_process', 'net', 'stream', 'tls', 'util', 'buffer', 'url', 'path', 'http', 'https', 'zlib', 'os', 'crypto', 'string_decoder'];

const nodeBuiltinPlugin = {
  name: 'node-builtins',
  setup(build) {
    build.onResolve({ filter: new RegExp(`^(${nodeBuiltins.join('|')})$`) }, args => ({
      path: args.path,
      namespace: 'node-builtin',
    }));
    build.onLoad({ filter: /.*/, namespace: 'node-builtin' }, () => ({
      contents: 'module.exports = {};',
    }));
  },
};

const isWatch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/app.js'],
  bundle: true,
  outfile: 'www/app.js',
  minify: !isWatch,
  plugins: [nodeBuiltinPlugin],
};

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(options).catch(() => process.exit(1));
}
