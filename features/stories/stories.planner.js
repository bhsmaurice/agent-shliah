'use strict';
const {randomUUID}=require('node:crypto');
const DAYS=['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
const clean=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
function schedule(value){
  const s=clean(value),days=DAYS.map((d,i)=>new RegExp('\\b'+d+'s?\\b').test(s)?i:-1).filter(i=>i>=0);
  const m=/\b([01]?\d|2[0-3])\s*(?:h|:)\s*([0-5]\d)?\b/.exec(s);
  if(!days.length||!m)return null;
  return {days,time:m[1].padStart(2,'0')+':'+(m[2]||'00')};
}
const summary=d=>`${d.days.map(i=>DAYS[i]).join(', ')} à ${d.time} (heure de Paris)\n${{music:'Avec nigoun',image:'Sans musique',reminder:'Rappel uniquement'}[d.mode]}\n${d.targets.length?d.targets.join(' et '):'Partage WhatsApp manuel'}`;
function options(value){
  const v=clean(value),out={};
  if(/\brappel(?: uniquement| seul)?\b/.test(v))out.mode='reminder';
  else if(/sans (?:musique|nigoun)|\bvideo\b/.test(v))out.mode='image';
  else if(/\bnigoun\b|avec musique/.test(v))out.mode='music';
  if(/whatsapp(?: uniquement| seul)?/.test(v))out.targets=[];
  else if(/les deux/.test(v)||(/instagram/.test(v)&&/facebook/.test(v)))out.targets=['instagram','facebook'];
  else if(/instagram/.test(v))out.targets=['instagram'];
  else if(/facebook/.test(v))out.targets=['facebook'];
  if(out.mode==='reminder')out.targets=[];
  return out;
}
function init({pool,ensureDB,isAdmin,adminPhone,text,wa,paris,isHolyTime,downloadMedia,createDraft,preview,addMusic,notifyPlan}){
  const save=(phone,data)=>pool.query('INSERT INTO story_plan_sessions(phone,data) VALUES($1,$2) ON CONFLICT(phone) DO UPDATE SET data=$2,created_at=NOW()',[phone,JSON.stringify(data)]);
  async function ask(phone,d,body,choices){
    d={...d,token:randomUUID().slice(0,8)};await save(phone,d);
    if(wa){try{await wa(phone,{type:'interactive',interactive:{type:'button',body:{text:body},action:{buttons:choices.map(([action,title])=>({type:'reply',reply:{id:`st_plan_${d.token}_${action}`,title}}))}}});return true;}catch(_){}}
    await text(phone,body+'\n'+choices.map(([,title])=>title).join(' · '));return true;
  }
  async function review(phone,d){
    if(d.mode==='reminder')d.targets=[];
    return ask(phone,{...d,step:'confirm'},'Voici la programmation :\n'+summary(d)+'\n\nChaque semaine, tu recevras ton visuel. Aucune publication sans ta validation.',[['confirm','✅ Confirmer'],['options','⚙️ Modifier'],['cancel','❌ Annuler']]);
  }
  async function modeChoice(phone,d){
    return ask(phone,{...d,step:'mode'},'Pour ce visuel, choisis :',d.mime==='video/mp4'?[['image','Garder la vidéo'],['reminder','🔔 Rappel seul']]:[['music','🎵 Avec nigoun'],['image','Sans musique'],['reminder','🔔 Rappel seul']]);
  }
  async function changeOptions(phone,d){
    d={...d,step:'options',token:randomUUID().slice(0,8)};await save(phone,d);
    const rows=[['music','Avec nigoun'],['image','Sans nigoun ajouté'],['reminder','Rappel seul'],['both','Instagram + Facebook'],['ig','Instagram uniquement'],['fb','Facebook uniquement'],['manual','WhatsApp manuel'],['date','Changer jour / heure'],['back','Revenir au résumé']].filter(([a])=>d.mime!=='video/mp4'||a!=='music').map(([a,title])=>({id:`st_plan_${d.token}_${a}`,title}));
    if(wa){try{await wa(phone,{type:'interactive',interactive:{type:'list',body:{text:'Que veux-tu changer ?'},action:{button:'Choisir une option',sections:[{title:'Ma programmation',rows}]}}});return true;}catch(_){}}
    await text(phone,'Écris par exemple « lundi 15h avec nigoun Instagram », ou « rappel seul ».');return true;
  }
  async function handleButton(phone,value){
    if(!/^st_plan_/.test(value||''))return false;
    if(!isAdmin(phone))return true;
    await ensureDB();
    const match=/^st_plan_([a-f0-9]{8})_(confirm|options|cancel|music|image|reminder|both|ig|fb|manual|date|back)$/.exec(value);
    const row=(await pool.query("SELECT data FROM story_plan_sessions WHERE phone=$1 AND created_at>NOW()-INTERVAL '1 hour'",[phone])).rows[0];
    if(!match||!row||row.data.token!==match[1]){await text(phone,'Ce bouton a expiré. Utilise le dernier message du bot.');return true;}
    const d=row.data,a=match[2];
    await pool.query('INSERT INTO story_admin_activity(phone) VALUES($1) ON CONFLICT(phone) DO UPDATE SET last_inbound=NOW()',[phone]);
    if(a==='cancel'){await pool.query('DELETE FROM story_plan_sessions WHERE phone=$1 AND data=$2::jsonb',[phone,JSON.stringify(d)]);await text(phone,'Préparation annulée.');return true;}
    if(a==='confirm'&&d.step==='confirm')return advance(phone,'confirmer',d);
    if(a==='options'&&d.step==='confirm')return changeOptions(phone,d);
    if(d.step==='options'){
      if(a==='date'){await save(phone,{...d,step:'schedule'});await text(phone,'Indique le jour et l’heure, par exemple « lundi 15h ».');return true;}
      if(a==='back')return review(phone,d);
      if(['both','ig','fb','manual'].includes(a))return review(phone,{...d,targets:{both:['instagram','facebook'],ig:['instagram'],fb:['facebook'],manual:[]}[a],mode:a==='manual'?'reminder':d.mode==='reminder'?'image':d.mode});
    }
    if(['mode','options'].includes(d.step)&&['music','image','reminder'].includes(a))return advance(phone,{music:'nigoun',image:'sans musique',reminder:'rappel'}[a],{...d,step:'mode'});
    await text(phone,'Ce bouton ne correspond plus au choix en cours.');return true;
  }
  async function handleText(phone,value){
    if(!isAdmin(phone))return false;
    await ensureDB();
    await pool.query('INSERT INTO story_admin_activity(phone) VALUES($1) ON CONFLICT(phone) DO UPDATE SET last_inbound=NOW()',[phone]);
    const v=clean(value),command=/^(?:statu|statut|statuts|stories) (programmer|programmes|annuler|modifier [a-f0-9]{8}|arreter [a-f0-9]{8})$/.exec(v);
    const natural=/^programme(?:r)? (?:ce |un |le |mon )?(?:visuel|statut|statu)\b/.test(v);
    if(!command&&!natural){await ensureDB();const row=(await pool.query("SELECT data FROM story_plan_sessions WHERE phone=$1 AND created_at>NOW()-INTERVAL '1 hour'",[phone])).rows[0];if(!row)return false;return advance(phone,v,row.data);}
    await ensureDB();
    const action=command?.[1];
    if(action==='annuler'){await pool.query('DELETE FROM story_plan_sessions WHERE phone=$1',[phone]);await text(phone,'Préparation annulée. Tes programmations enregistrées restent inchangées.');return true;}
    if(action==='programmes'){
      const rows=(await pool.query('SELECT * FROM story_plans WHERE owner=$1 AND enabled ORDER BY id',[phone])).rows;
      await text(phone,rows.length?rows.map(r=>r.id.slice(0,8)+' — '+summary(r)).join('\n\n')+'\n\nPour modifier : statut modifier CODE\nPour arrêter : statut arrêter CODE':'Aucune programmation personnelle. Écris « statut programmer » pour en créer une.');return true;
    }
    if(action?.startsWith('arreter ')||action?.startsWith('modifier ')){
      const rows=(await pool.query('SELECT * FROM story_plans WHERE owner=$1 AND enabled AND LEFT(id::text,8)=$2',[phone,action.split(' ')[1]])).rows;
      if(rows.length!==1){await text(phone,'Code introuvable. Écris « statut programmes » pour voir tes programmations.');return true;}
      const plan=rows[0];
      if(action.startsWith('arreter ')){
        await pool.query('UPDATE story_plans SET enabled=FALSE,revision=revision+1 WHERE id=$1 AND owner=$2',[plan.id,phone]);await invalidate(plan.id,phone);await text(phone,'Programmation arrêtée. Aucun nouvel envoi prévu pour ce visuel.');return true;
      }
      const stored=(await pool.query('SELECT mime FROM story_media WHERE id=$1',[plan.media_id])).rows[0];await save(phone,{...plan,mime:stored.mime,step:'schedule'});await text(phone,'Indique les nouveaux jours et l’heure, par exemple « lundi à 15h ». Le visuel sera conservé. Pour le remplacer, crée une nouvelle programmation.');return true;
    }
    await save(phone,{step:'media',...(schedule(value)||{}),...options(value)});
    await text(phone,'Envoie ton visuel. Tu peux écrire en légende « lundi 15h avec nigoun », ou choisir ensuite avec les boutons.');return true;
  }
  async function invalidate(id,owner){await pool.query("UPDATE story_drafts SET status='cancelled' WHERE owner=$1 AND slot LIKE $2 AND status='preview'",[owner,'plan:'+id+':%']);}
  async function advance(phone,v,d){
    if(d.step==='media'){await text(phone,'Envoie une image ou une vidéo, ou écris « statut annuler ».');return true;}
    if(d.step==='schedule'){
      const parsed=schedule(v);if(!parsed){await text(phone,'Indique le jour et l’heure de notification, par exemple « tous les lundis à 15h ».');return true;}
      d={...d,...parsed,...options(v)};if(d.mode)return advance(phone,{music:'nigoun',image:'sans musique',reminder:'rappel'}[d.mode],{...d,step:'mode'});return modeChoice(phone,d);
    }
    if(d.step==='mode'){
      const mode=/^(rappel|rappel uniquement)$/.test(v)?'reminder':/^(sans musique|sans|video)$/.test(v)?'image':/^(nigoun|avec nigoun|musique)$/.test(v)&&d.mime!=='video/mp4'?'music':null;
      if(!mode){await text(phone,'Réponds « nigoun », « sans musique » ou « rappel ». Pour une vidéo, écris « vidéo » ou « rappel ».');return true;}
      if(mode==='music'&&!(await pool.query('SELECT id FROM story_clips WHERE enabled ORDER BY id')).rows.length){await text(phone,'Aucun nigoun disponible. Choisis sans musique ou rappel.');return true;}
      return review(phone,{...d,mode,targets:mode==='reminder'?[]:(d.targets||['instagram','facebook'])});
    }
    if(d.step==='targets'){
      if(d.mode==='reminder')return review(phone,{...d,targets:[]});
      const targets=v==='instagram'?['instagram']:v==='facebook'?['facebook']:v==='les deux'?['instagram','facebook']:/^whatsapp(?: uniquement)?$/.test(v)?[]:null;
      if(!targets){await text(phone,'Réponds Instagram, Facebook, les deux ou WhatsApp uniquement.');return true;}
      return review(phone,{...d,targets:d.mode==='reminder'?[]:targets});
    }
    if(d.step==='options'){const picked=options(v),date=schedule(v);if(!Object.keys(picked).length&&!date)return changeOptions(phone,d);return review(phone,{...d,...picked,...(date||{})});}
    if(d.step==='confirm'){
      if(v!=='confirmer'){const picked=options(v),date=schedule(v);if(Object.keys(picked).length||date)return review(phone,{...d,...picked,...(date||{})});return review(phone,d);}
      const claim=(await pool.query("DELETE FROM story_plan_sessions WHERE phone=$1 AND data=$2::jsonb AND created_at>NOW()-INTERVAL '1 hour' RETURNING data",[phone,JSON.stringify(d)])).rows[0];if(!claim)return true;
      const id=d.id||randomUUID();
      if(d.id){await pool.query('UPDATE story_plans SET days=$3,time=$4,mode=$5,targets=$6,revision=revision+1 WHERE id=$1 AND owner=$2 AND enabled',[id,phone,JSON.stringify(d.days),d.time,d.mode,JSON.stringify(d.targets)]);await invalidate(id,phone);}
      else await pool.query('INSERT INTO story_plans(id,owner,media_id,days,time,mode,targets) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,phone,d.media_id,JSON.stringify(d.days),d.time,d.mode,JSON.stringify(d.targets)]);
      await text(phone,'Programmation enregistrée : '+id.slice(0,8)+'\n'+summary(d)+'\nAucune publication effectuée. Pour gérer : statut programmes.');return true;
    }
    return false;
  }
  async function handleMedia(phone,message){
    if(!isAdmin(phone))return false;
    let row=(await pool.query("SELECT data FROM story_plan_sessions WHERE phone=$1 AND created_at>NOW()-INTERVAL '1 hour'",[phone])).rows[0];
    const caption=(message.image||message.video)?.caption||'';
    if(!row&&/^(?:statut? programmer|programme(?:r)? (?:ce |un |le |mon )?(?:visuel|statut))\b/.test(clean(caption))){await ensureDB();row={data:{step:'media'}};}
    if(!row)return false;
    if(row.data.step!=='media'){await text(phone,'Une programmation est en cours. Termine les choix ou écris « statut annuler ».');return true;}
    const media=message.image||message.video;if(!media)return false;
    try{
      const file=await downloadMedia(media.id);let data=file.buffer,mime=file.mimeType;
      if(!['image/jpeg','image/png','video/mp4'].includes(mime)||data.length>20*1024*1024)throw new Error('Envoie une image ou un MP4 de moins de 20 Mo.');
      if(mime!=='video/mp4'){data=await require('sharp')(data).rotate().jpeg().toBuffer();mime='image/jpeg';}
      const id=randomUUID();await pool.query('INSERT INTO story_media(id,data,mime) VALUES($1,$2,$3)',[id,data,mime]);
      const d={...row.data,...(schedule(caption)||{}),...options(caption),media_id:id,mime,step:'schedule'};await save(phone,d);
      if(d.days)return advance(phone,d.days.map(i=>DAYS[i]).join(' ')+' '+d.time,d);
      await text(phone,'Visuel reçu. Écris par exemple « lundi 15h avec nigoun », ou « dimanche 10h rappel seul ».');
    }catch(e){await text(phone,'Visuel non enregistré : '+e.message);}
    return true;
  }
  async function tick(now){
    const p=paris(now),day=new Date(p.date+'T12:00:00Z').getUTCDay();
    const plans=(await pool.query('SELECT * FROM story_plans WHERE enabled')).rows;
    for(const plan of plans){
      const [h,m]=plan.time.split(':').map(Number),elapsed=p.minute-h*60-m;
      if(!plan.days.includes(day)||elapsed<0||elapsed>15||!isHolyTime||await isHolyTime(now))continue;
      const claimed=(await pool.query('INSERT INTO story_plan_jobs(plan_id,date,revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING plan_id',[plan.id,p.date,plan.revision])).rows;if(!claimed.length)continue;
      try{
        let media=plan.media_id;
        if(plan.mode==='music'){
          const clips=(await pool.query('SELECT id FROM story_clips WHERE enabled ORDER BY id')).rows;
          // Only the two attributed, licensed recordings supported by the composer.
          const tracks=clips.filter(c=>/^a13c774a-cbe9-4f17-b826-cd77ce59900[12]$/.test(c.id));if(!tracks.length)throw new Error('Nigoun indisponible');
          const pick=tracks[Math.floor(new Date(p.date+'T12:00:00Z').getTime()/604800000)%tracks.length];
          const source=(await pool.query('SELECT data FROM story_media WHERE id=$1',[media])).rows[0];
          const result=await addMusic(source.data,pick.id);media=randomUUID();await pool.query('INSERT INTO story_media(id,data,mime) VALUES($1,$2,$3)',[media,result.data,result.mime]);
        }
        // Recheck after potentially slow rendering: stopping/editing a plan invalidates this occurrence.
        const live=(await pool.query('SELECT id FROM story_plans WHERE id=$1 AND enabled AND revision=$2',[plan.id,plan.revision])).rows;if(!live.length)continue;
        const draft=await createDraft(plan.owner,media,null,`plan:${plan.id}:${p.date}:${plan.revision}`,'story',plan.mode==='reminder'?[]:plan.targets);
        if(draft)await notifyPlan(draft);
        await pool.query("UPDATE story_plan_jobs SET status='notified' WHERE plan_id=$1 AND date=$2 AND revision=$3",[plan.id,p.date,plan.revision]);
      }catch(e){await pool.query("UPDATE story_plan_jobs SET status='failed' WHERE plan_id=$1 AND date=$2 AND revision=$3",[plan.id,p.date,plan.revision]);console.error('Stories : échéance non confirmée');}
    }
  }
  return {handleText,handleMedia,handleButton,tick};
}
module.exports={init,schedule,summary,options};
