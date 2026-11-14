'use strict';
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function targets(value) {
  if (!Array.isArray(value) || value.length > 2 || value.some(v=>!['instagram','facebook'].includes(v))) throw new Error('Réseaux invalides');
  return [...new Set(value)];
}
function reminder(value) {
  const days=[...new Set(value.days||[])];
  if(!days.length||days.some(d=>!Number.isInteger(d)||d<0||d>6)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time||'')||typeof value.message!=='string'||!value.message.trim()||value.message.length>600)throw new Error('Choisis les jours, l’heure et un texte de rappel (600 caractères maximum).');
  return {days,time:value.time,message:value.message.trim()};
}
function textSvg(value) {
  const words=String(value).trim().split(/\s+/);const lines=[];let line='';
  for(const word of words){if((line+' '+word).trim().length>28&&line){lines.push(line);line='';}line+=(line?' ':'')+word;}
  if(line)lines.push(line);
  const size=Math.min(72,Math.floor(1400/(lines.length*1.4)));const gap=size*1.4,top=(1920-gap*lines.length)/2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="white"/><text x="540" y="150" text-anchor="middle" fill="#ac7c15" font-family="sans-serif" font-size="30">BETH HABAD S MAURICE PLATEAU</text><g fill="#10294b" font-family="serif" font-size="${size}" text-anchor="middle">${lines.map((l,i)=>`<text x="540" y="${top+(i+1)*gap}">${escape(l)}</text>`).join('')}</g></svg>`;
}
module.exports={escape,targets,reminder,textSvg};
