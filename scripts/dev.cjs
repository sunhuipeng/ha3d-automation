'use strict';
/* 跨平台开发模式启动器（npm run start:dev）。
 * Windows CMD/PowerShell 不支持 Unix 内联环境变量写法（HA3D_DEV_MODE=true node ...），
 * 会把它当成命令名报"'HA3D_DEV_MODE' 不是内部或外部命令"。
 * 这里先在同一进程设置 env，再加载真正的入口——行为与 macOS/Linux 完全一致，零额外依赖。 */
process.env.HA3D_DEV_MODE = 'true';
require('../server/index.js');
