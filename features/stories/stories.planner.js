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
function init({pool,ensureDB,isAdmin,adminPhone,text,paris,isHolyTime,downloadMedia,createDraft,preview,addMusic,notifyPlan}){
  const save=(phone,data)=>pool.query('INSERT INTO story_plan_sessions(phone,data) VALUES($1,$2) ON CONFLICT(phone) DO UPDATE SET data=$2,created_at=NOW()',[phone,JSON.stringify(data)]);
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
    await save(phone,{step:'media',...(schedule(value)||{})});
    await text(phone,'Envoie le visuel ou la vidéo à programmer. Tu choisiras ensuite les jours, l’heure et les réseaux. Pour quitter : statut annuler.');return true;
  }
  async function invalidate(id,owner){await pool.query("UPDATE story_drafts SET status='cancelled' WHERE owner=$1 AND slot LIKE $2 AND status='preview'",[owner,'plan:'+id+':%']);}
  async function advance(phone,v,d){
    if(d.step==='media'){await text(phone,'Envoie une image ou une vidéo, ou écris « statut annuler ».');return true;}
    if(d.step==='schedule'){
      const parsed=schedule(v);if(!parsed){await text(phone,'Indique le jour et l’heure de notification, par exemple « tous les lundis à 15h ».');return true;}
      d={...d,...parsed,step:'mode'};await save(phone,d);await text(phone,d.mime==='video/mp4'?'Choisis « vidéo » pour garder son son, ou « rappel » pour un partage manuel.':'Choisis « nigoun », « sans musique » ou « rappel uniquement ».');return true;
    }
    if(d.step==='mode'){
      const mode=/^(rappel|rappel uniquement)$/.test(v)?'reminder':/^(sans musique|sans|video)$/.test(v)?'image':/^(nigoun|avec nigoun|musique)$/.test(v)&&d.mime!=='video/mp4'?'music':null;
      if(!mode){await text(phone,'Réponds « nigoun », « sans musique » ou « rappel ». Pour une vidéo, écris « vidéo » ou « rappel ».');return true;}
      if(mode==='music'&&!(await pool.query('SELECT id FROM story_clips WHERE enabled ORDER BY id')).rows.length){await text(phone,'Aucun nigoun disponible. Choisis sans musique ou rappel.');return true;}
      d={...d,mode,step:'targets'};await save(phone,d);await text(phone,'Choisis « Instagram », « Facebook », « les deux » ou « WhatsApp uniquement » (partage manuel).');return true;
    }
    if(d.step==='targets'){
      const targets=v==='instagram'?['instagram']:v==='facebook'?['facebook']:v==='les deux'?['instagram','facebook']:/^whatsapp(?: uniquement)?$/.test(v)?[]:null;
      if(!targets){await text(phone,'Réponds Instagram, Facebook, les deux ou WhatsApp uniquement.');return true;}
      d={...d,targets,step:'confirm'};await save(phone,d);await text(phone,'Voici la programmation :\n'+summary(d)+'\n\nÀ chaque échéance, tu recevras une demande avant publication. Sans validation, rien ne part.\nÉcris « confirmer » pour enregistrer ou « statut annuler ».');return true;
    }
    if(d.step==='confirm'){
      if(v!=='confirmer'){await text(phone,'Écris « confirmer » pour enregistrer, ou « statut annuler ».');return true;}
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
    const row=(await pool.query("SELECT data FROM story_plan_sessions WHERE phone=$1 AND created_at>NOW()-INTERVAL '1 hour'",[phone])).rows[0];if(!row)return false;
    if(row.data.step!=='media'){await text(phone,'Une programmation est en cours. Termine les choix ou écris « statut annuler ».');return true;}
    const media=message.image||message.video;if(!media)return false;
    try{
      const file=await downloadMedia(media.id);let data=file.buffer,mime=file.mimeType;
      if(!['image/jpeg','image/png','video/mp4'].includes(mime)||data.length>20*1024*1024)throw new Error('Envoie une image ou un MP4 de moins de 20 Mo.');
      if(mime!=='video/mp4'){data=await require('sharp')(data).rotate().jpeg().toBuffer();mime='image/jpeg';}
      const id=randomUUID();await pool.query('INSERT INTO story_media(id,data,mime) VALUES($1,$2,$3)',[id,data,mime]);
      const d={...row.data,media_id:id,mime,step:'schedule'};await save(phone,d);
      if(d.days)return advance(phone,d.days.map(i=>DAYS[i]).join(' ')+' '+d.time,d);
      await text(phone,'Visuel reçu. Quels jours et à quelle heure veux-tu recevoir la demande ? Exemple : tous les lundis à 15h.');
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
  return {handleText,handleMedia,tick};
}
module.exports={init,schedule,summary};
