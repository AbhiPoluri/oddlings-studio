import {type Action,type World,random} from './world.ts';
export type Decision={choice:Action;confidence:number;probabilities:Record<string,number>};
const clamp=(n:number)=>Math.round(Math.max(0,Math.min(100,n)));
export function advance(world:World,event:string,picks:Decision[]){
 const available=Math.max(0,world.food+(event==='A surprise feast'?12:event==='A food shortage'?-8:0))+5*picks.filter(p=>p.choice==='forage').length;
 const hoarders=picks.filter(p=>p.choice==='hoard').length;
 // Resolve simultaneous claims with equal whole shares; remainder stays communal.
 const share=hoarders?Math.min(3,Math.floor(available/hoarders)):0;
 const food=Math.max(0,Math.min(10000,available-share*hoarders-world.residents.length));
 const events:string[]=[];
 const descriptions:Record<Action,string>={forage:'gathered food for the clearing.',rest:'found a quiet spot for a nap.',socialize:'made everyone feel a little less alone.',hoard:share?'stashed away some shared supplies.':'looked for supplies to hoard, but found none.',mischief:'caused a completely unnecessary disturbance.',shelter:'tucked into a hut for safety.'};
 const residents=world.residents.map((p,i)=>{const rng=random(p.seed+world.day*919);const a=picks[i].choice;let energy=p.energy-3,happiness=p.happiness;switch(a){case 'forage':energy-=12;break;case 'rest':energy+=20;break;case 'socialize':energy-=6;happiness+=12;break;case 'hoard':energy+=Math.round(share*8/3);break;case 'mischief':energy-=8;happiness+=12;break;case 'shelter':energy+=5;break}
 picks.forEach((other,j)=>{if(j!==i)happiness+=other.choice==='socialize'?2:other.choice==='mischief'?-5:other.choice==='hoard'&&share>0?-3:0});
 if(event==='A thunderstorm'&&a!=='shelter')happiness-=8;if(food===0)happiness-=8;
 const lane=p.seed%3,row=Math.floor(p.seed/3)%2;let x=p.x,y=p.y;
 if(a==='shelter'){x=190+lane*175;y=185+row*40}else if(a==='rest'){x=115+lane*215;y=345+row*36}else if(a==='forage'){x=90+lane*245+rng()*25;y=210+row*120}else{x=155+lane*190+rng()*20;y=245+row*100}
 events.push(`${p.name} ${descriptions[a]}`);return{...p,energy:clamp(energy),happiness:clamp(happiness),x:Math.round(x),y:Math.round(y),action:a,probabilities:picks[i].probabilities,confidence:picks[i].confidence}});
 return{world:{...world,day:world.day+1,food,residents},events};
}
