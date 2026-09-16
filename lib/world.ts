export const actions={forage:'Gather food',rest:'Take a nap',socialize:'Make a friend',hoard:'Hoard supplies',mischief:'Cause trouble',shelter:'Find shelter'};
export type Action=keyof typeof actions;
export type Resident={name:string;seed:number;personality:string;energy:number;happiness:number;x:number;y:number;action?:Action;probabilities?:Record<string,number>;confidence?:number};
export type World={seed:number;day:number;food:number;residents:Resident[]};
export function random(seed:number){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
export function makeWorld(seed:number):World{const r=random(seed);return{seed,day:1,food:30,residents:['Mog','Pip','Grumble','Nim','Boggle','Dot'].map((name,i)=>({name,seed:Math.floor(r()*1000000),personality:['Kindhearted, curious, and easily distracted','Very sociable. Thinks everyone is a friend.','Grumpy, territorial, secretly generous','Shy, cautious, and fond of naps','Chaotic, playful, and always hungry','Practical, hardworking, and protective'][i],energy:65+Math.floor(r()*30),happiness:55+Math.floor(r()*35),x:140+(i%3)*215+Math.floor(r()*30),y:225+Math.floor(i/3)*125+Math.floor(r()*25)}))}}

