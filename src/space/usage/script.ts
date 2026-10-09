/**
 * The heartbeat script an app page loads with `<script src="/_space/usage.js" defer></script>`
 * (docs/usage.md#heartbeat). Plain ES5, no library, under 2 KB. The router serves it from
 * the app's own hostname, so its POSTs are same-origin and carry no token.
 *
 * - A random id per browser tab, kept in `sessionStorage`.
 * - While the page is visible and had a pointer, key, wheel, touch or scroll event in the last
 *   120 s, one POST to `/_space/usage/beat` every 30 s; the first goes out at once.
 * - On `visibilitychange` to hidden and on `pagehide`, one last beat through `sendBeacon`.
 * - Every failure is ignored: the app must not notice the script.
 */

export const USAGE_PATH = "/_space/usage/beat";
export const IDLE_MS = 120_000;
export const BEAT_EVERY_MS = 30_000;

export const USAGE_SCRIPT = `(function(){try{
var P="${USAGE_PATH}",K="space-usage-tab",I=${IDLE_MS},E=${BEAT_EVERY_MS},tab,last=0,act=0;
try{tab=sessionStorage.getItem(K)}catch(e){}
if(!tab||!/^[A-Za-z0-9_-]{8,64}$/.test(tab)){tab=(Math.random().toString(36).slice(2)+Date.now().toString(36)).slice(0,32);try{sessionStorage.setItem(K,tab)}catch(e){}}
function now(){return Date.now()}
function busy(){return now()-act<I}
function send(b){last=now();var s=JSON.stringify({tab:tab});try{if(b&&navigator.sendBeacon){navigator.sendBeacon(P,new Blob([s],{type:"text/plain"}));return}fetch(P,{method:"POST",body:s,headers:{"content-type":"text/plain"},keepalive:true,credentials:"same-origin"}).catch(function(){})}catch(e){}}
function tick(){if(document.visibilityState==="visible"&&busy()&&now()-last>=E-1000)send(false)}
function poke(){act=now();tick()}
function bye(){if(busy()&&now()-last>=20000)send(true)}
var ev=["pointerdown","keydown","wheel","touchstart","scroll"];for(var i=0;i<ev.length;i++)window.addEventListener(ev[i],poke,{passive:true,capture:true});
document.addEventListener("visibilitychange",function(){document.visibilityState==="hidden"?bye():poke()});
window.addEventListener("pagehide",bye);
setInterval(tick,10000);
poke();
}catch(e){}})();
`;
