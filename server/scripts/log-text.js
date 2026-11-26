'use strict';
/* 影子拦截日志文案：脚本层闸（runner）与执行器层硬闸（executor）共用，
 * 保证两道闸的检索/统计口径一致（原两处各自拼装，格式漂移）。 */

function shadowWrite(desc, op) {
  return `[影子·拦截写操作] ${desc}（action.${op}，未下发）`;
}

function shadowHa(domain, service, eid) {
  return `[影子·拦截 HA 调用·未下发] ${domain}.${service}${eid ? ' → ' + eid : ''}`;
}

/* 开发模式拦截：全局开发模式下连正式实例的设备写也只记日志、不下发。
 * 与影子拦截分开文案，便于排查时区分“脚本是影子”还是“环境是开发”。 */
function devWrite(desc, op) {
  return `[开发模式·拦截写操作] ${desc}（action.${op}，未下发）`;
}

function devHa(domain, service, eid) {
  return `[开发模式·拦截 HA 调用·未下发] ${domain}.${service}${eid ? ' → ' + eid : ''}`;
}

module.exports = { shadowWrite, shadowHa, devWrite, devHa };
