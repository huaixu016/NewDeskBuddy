export default {
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      // 多页入口：index.html 是宠物窗口，menu.html 是右键菜单悬浮窗，
      // work.html 是工作模式面板，dialog.html 是共用弹窗窗。
      input: {
        main: 'index.html',
        menu: 'menu.html',
        work: 'work.html',
        dialog: 'dialog.html',
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
}
