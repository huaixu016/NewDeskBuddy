export default {
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      // 多页入口：index.html 是宠物窗口，menu.html 是右键菜单悬浮窗。
      input: {
        main: 'index.html',
        menu: 'menu.html',
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
}
