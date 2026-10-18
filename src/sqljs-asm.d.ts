declare module 'sql.js/dist/sql-asm.js' {
  import initSqlJs from 'sql.js';
  const init: typeof initSqlJs;
  export default init;
}
