
// Blip mascot rig driver (extracted from the design kit)
export const ST = {
idle:{n:"Idle",c:"#FFD66B",h:"Ready",t:"Nothing running",d:"Breathes, blinks, ears wobble out of sync, eyes drift. The antenna light pulses in the brand color.",e:"n",m:"smile",p:[10,-10,4,4,0,0,0,0,0],b:["breathe",4],k:["drift",9]},
think:{n:"Planning",c:"#FFD66B",h:"Thinking",t:"Building a plan",d:"Eyes up and right, hand on chin, a thought cloud with three bouncing dots, slow head sway.",e:"n",m:"smirk",p:[14,58,3,2.4,7,-7,-1,10,1],b:["sway",3.6]},
browse:{n:"Browser",c:"#62B4FF",h:"Browsing",t:"Opening a page",d:"A window floats in beside it. Eyes sweep side to side, arm points at the page, the cursor wanders.",e:"n",m:"smile",p:[12,-115,6,1.6,0,0,0,0,0],b:["bob",1.8],k:["scan",2.2]},
search:{n:"Search",c:"#4FD1E8",h:"Searching",t:"Searching the web",d:"Brows up, mouth a small o, eyes wide. Holds a magnifier and sweeps it in a slow arc while leaning in.",e:"wide",m:"o",p:[22,-100,5,1.8,4,0,-6,0,1],b:["lean",2.6]},
read:{n:"Files",c:"#5FD8A6",h:"Reading",t:"Reading a file",d:"A page floats left, a highlight walks down the lines, eyes scan line by line, a slow nod.",e:"n",m:"flat",p:[100,14,3,2.6,0,0,0,6,1],b:["nod",3.2],k:["rd",3]},
code:{n:"Terminal",c:"#FF7EB6",h:"Running code",t:"Executing a command",d:"Hands tap an unseen keyboard in alternation, body buzzes in time, a terminal types itself out.",e:"n",m:"smirk",p:[-40,40,13,.36,0,3,0,12,1],b:["buzz",.36]},
mail:{n:"Email",c:"#B59CFF",h:"Sending mail",t:"Writing or sending email",d:"Holds up an envelope, then does a squash and stretch hop as it flies away. Shadow shrinks at the peak.",e:"n",m:"smile",p:[10,-100,5,1.4,4,0,0,0,0],b:["hop",1.8,1]},
pay:{n:"Wallet",c:"#FF7A6B",h:"Checking out",t:"Handling a payment",d:"Careful, never rushed. Eyes squint at the card, brows furrowed, a lock bobs nearby, slow side lean.",e:"squint",m:"flat",p:[-52,52,1.5,3,0,4,1,14,1],b:["careful",3.4]},
approve:{n:"Approval",c:"#FF7A6B",h:"Waiting on you",t:"Needs your OK",d:"Holds the decision out with both hands, hopeful brows, wide eyes, a double bounce and a pulsing ring.",e:"wide",m:"o",p:[-52,52,3,1,0,3,-6,-12,1],b:["hope",1.6,1]},
success:{n:"Done",c:"#5FD8A6",h:"All done",t:"Task finished",d:"Arms up, happy closed eyes, big grin, a tall jump with squash and stretch, confetti and a check badge pop.",e:"happy",m:"grin",p:[155,-155,10,.5,0,-2,-4,0,1],b:["cheer",1.9,1]},
error:{n:"Error",c:"#FF6B81",h:"Hit a snag",t:"Something failed",d:"Ears droop, brows worry, head tilts, hands tremble at the belly, a sweat drop slides down and a badge wobbles.",e:"wide",m:"sad",p:[-25,25,2,.25,-3,3,0,-16,1],b:["droop",2.4]},
sleep:{n:"Background",c:"#8E86B8",h:"Working in the background",t:"App closed, still working",d:"Eyes shut, ears down, deep slow breathing and floating Zs. Wakes with a stretch when it needs you.",e:"closed",m:"flat",p:[6,-6,2,5,0,0,2,0,0],b:["snore",4.8]}};
Object.assign(ST, {
wave:{n:"Hello",c:"#FFD66B",h:"Hi there",t:"Greets you",d:"Big waving arm, happy closed eyes, a grin, a small double bounce and a speech bubble.",e:"happy",m:"grin",p:[12,-140,26,.55,0,0,-4,0,1],b:["hope",1.8]},
listen:{n:"Listening",c:"#67E8F9",h:"Listening",t:"Voice mode",d:"Hand cupped to ear, ears perk toward you, wide eyes, a live voice meter bounces.",e:"wide",m:"o",p:[170,-10,3,1.6,3,0,-5,-8,1],b:["lean",2.2]},
wait:{n:"Waiting",c:"#CBD5E1",h:"Waiting it out",t:"Long task or rate limit",d:"Arms crossed, patient eyes on a flipping hourglass, slow sway.",e:"n",m:"flat",p:[-55,55,1.5,3,5,-4,0,10,1],b:["sway",3.8]},
write:{n:"Writing",c:"#FFA94D",h:"Writing",t:"Editing a file or note",d:"Holds a notepad, the pen hand scribbles, eyes follow the lines as they appear.",e:"n",m:"smirk",p:[-52,40,8,.5,0,4,0,12,1],b:["nod",2.4]},
data:{n:"Analysis",c:"#2DD4BF",h:"Crunching numbers",t:"Data and spreadsheets",d:"Puts on glasses, points at a chart whose bars grow in turn, leans in to inspect.",e:"n",m:"smirk",p:[12,-105,4,1.8,4,-3,-2,8,1],b:["lean",2.6]},
message:{n:"Messages",c:"#7C9CFF",h:"Chatting",t:"Slack, SMS, chat",d:"Chat bubbles pop in and out, typing dots bounce, an arm points at the thread.",e:"n",m:"smile",p:[14,-115,5,1.4,5,-4,-3,0,0],b:["bob",1.6]},
calendar:{n:"Calendar",c:"#A3E635",h:"Scheduling",t:"Booking or checking time",d:"A calendar floats in, the header flips like a page and today's date pulses.",e:"n",m:"smile",p:[12,-120,5,2,4,-4,0,0,0],b:["bob",2]},
shop:{n:"Shopping",c:"#E879F9",h:"Shopping",t:"Filling a cart",d:"Pushes a small cart, items drop in one by one with a soft bob.",e:"n",m:"smile",p:[-52,52,2,2.2,0,4,0,0,0],b:["bob",1.4]},
create:{n:"Creating",c:"#FF8FA3",h:"Making something",t:"Image or design generation",d:"Paints with a brush, strokes draw themselves on a canvas, sparkles twinkle.",e:"wide",m:"smile",p:[20,-100,6,1.6,-5,0,-3,0,1],b:["sway",2.8]},
memory:{n:"Memory",c:"#FFD66B",h:"Remembering",t:"Saving something for later",d:"A glowing note drops into its belly, the belly lights up, contented closed eyes.",e:"happy",m:"smile",p:[-45,45,2,2.6,0,0,2,0,0],b:["sway",3.4]},
delegate:{n:"Sub-agents",c:"#A78BFA",h:"Delegating",t:"Spawning helper agents",d:"Arms up like a conductor while three mini Blips, each with its own tool light, bounce off to work.",e:"wide",m:"smile",p:[125,-125,12,.7,0,-3,-4,0,1],b:["bob",1.2]}});

export function attachBlip(root) {
  const m = root.querySelector("#mx") || root.querySelector("svg");
  if (!m) throw new Error("mascot svg not found");
  const sp = (k, v) => m.style.setProperty(k, v);
  let cur = "idle";
  function set(k) {
    const s = ST[k] || ST.idle;
    m.classList.remove("chg");
    void m.getBoundingClientRect();
    m.classList.add("chg");
    cur = k;
    const [la, ra, w, wd, ex, ey, by, ba, bo] = s.p;
    m.dataset.s = k;
    m.dataset.e = s.e;
    m.dataset.m = s.m;
    sp("--la", la + "deg"); sp("--ra", ra + "deg"); sp("--w", w + "deg");
    sp("--wd", wd + "s"); sp("--ex", ex + "px"); sp("--ey", ey + "px");
    sp("--hx", ex * 0.3 + "px"); sp("--hy", ey * 0.25 + "px");
    sp("--by", by + "px"); sp("--ba", ba + "deg"); sp("--bo", bo);
    sp("--bk", s.b[0]); sp("--bd", s.b[1] + "s"); sp("--sk", s.b[2] ? "shd" : "none");
    sp("--ek", s.k ? s.k[0] : "none"); sp("--ekd", s.k ? s.k[1] + "s" : "3s");
    document.documentElement.style.setProperty("--t", s.c);
    m.querySelectorAll(".pr").forEach((p) => p.classList.toggle("on", p.classList.contains("pr-" + k)));
    // idle life: random micro-animations
    if (k === "idle") {
      setInterval(() => {
        if (cur !== "idle") return;
        const a = ["wink", "twitch", "hip"][Math.random() * 3 | 0];
        m.classList.add(a);
        setTimeout(() => m.classList.remove(a), 1000);
      }, 5200);
    }
    return s;
  }
  // eyes follow pointer
  let pq = 0;
  addEventListener("pointermove", (e) => {
    if (pq) return;
    pq = requestAnimationFrame(() => {
      pq = 0;
      const r = m.getBoundingClientRect();
      const c = (v, a, b) => Math.max(-1, Math.min(1, ((v - a) / b) * 2));
      m.style.setProperty("--px", c(e.clientX, r.left + r.width / 2, innerWidth) * 2.6 + "px");
      m.style.setProperty("--py", c(e.clientY, r.top + r.height / 2, innerHeight) * 2.2 + "px");
    });
  });
  set("idle");
  return { set, ST, el: m, current: () => cur };
}
