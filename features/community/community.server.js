'use strict';
const { timingSafeEqual } = require('node:crypto');
function init({app,pool,adminPassword}) {
  let ready;
  function ensureDB(){return ready ||= pool.query(`CREATE TABLE IF NOT EXISTS community_followup(phone TEXT PRIMARY KEY, groups_list JSONB NOT NULL DEFAULT '[]', attendance TEXT NOT NULL DEFAULT 'unknown', note TEXT NOT NULL DEFAULT '', last_contact DATE, next_contact DATE); ALTER TABLE community_followup ADD COLUMN IF NOT EXISTS portrait TEXT;`).catch(e=>{ready=null;throw e;});}
  const wrap=fn=>async(req,res)=>{try{await ensureDB();await fn(req,res);}catch(e){console.error('Community:',e.message);res.status(500).json({error:'Impossible de charger ou enregistrer les contacts.'});}};
  const auth=(req,res,next)=>{const a=Buffer.from(req.get('X-Admin-Password')||''),b=Buffer.from(adminPassword||'');if(!b.length||a.length!==b.length||!timingSafeEqual(a,b))return res.sendStatus(401);next();};
  app.get('/admin/community',(_req,res)=>res.sendFile(require('node:path').join(__dirname,'community.admin.html')));
  app.get('/admin/community/contacts',auth,wrap(async(_req,res)=>{res.set('Cache-Control','no-store');const r=await pool.query(`SELECT c.phone,c.prenom,c.nom,c.genre,c.email,COALESCE(f.groups_list,'[]'::jsonb) AS groups_list,COALESCE(f.attendance,'unknown') AS attendance,COALESCE(f.note,'') AS note,f.last_contact,f.next_contact,f.portrait FROM contacts c LEFT JOIN community_followup f ON f.phone=c.phone ORDER BY c.prenom NULLS LAST,c.nom NULLS LAST,c.phone`);res.json({contacts:r.rows});}));
  app.post('/admin/community/contact',auth,wrap(async(req,res)=>{
    const d=req.body,phone=String(d.phone||'').replace(/[\s()+.\-]/g,'');
    const statuses=['unknown','regular','recent','long','never','stop'];
    const date=v=>!v||(/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v)));
    if(!/^\d{8,15}$/.test(phone)||!statuses.includes(d.attendance)||!Array.isArray(d.groups_list)||d.groups_list.some(x=>!['Donateurs','Fidèles réguliers','Bénévoles et soutiens'].includes(x))||!date(d.last_contact)||!date(d.next_contact)||String(d.note||'').length>5000)return res.status(400).json({error:'Vérifie le numéro, les dates et les informations saisies.'});
    await pool.query(`INSERT INTO contacts(phone,prenom,nom,genre) VALUES($1,$2,$3,$4) ON CONFLICT(phone) DO UPDATE SET prenom=EXCLUDED.prenom,nom=EXCLUDED.nom,genre=EXCLUDED.genre`,[phone,String(d.prenom||'').slice(0,150),String(d.nom||'').slice(0,150),['homme','femme'].includes(d.genre)?d.genre:null]);
    await pool.query(`INSERT INTO community_followup(phone,groups_list,attendance,note,last_contact,next_contact) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(phone) DO UPDATE SET groups_list=EXCLUDED.groups_list,attendance=EXCLUDED.attendance,note=EXCLUDED.note,last_contact=EXCLUDED.last_contact,next_contact=EXCLUDED.next_contact`,[phone,JSON.stringify([...new Set(d.groups_list)]),d.attendance,d.note||'',d.last_contact||null,d.next_contact||null]);res.json({ok:true});
  }));
  app.post('/admin/community/portrait',auth,wrap(async(req,res)=>{
    res.set('Cache-Control','no-store');
    const {phone,portrait}=req.body;
    if(!/^\d{8,15}$/.test(String(phone||'')))return res.status(400).json({error:'Contact invalide.'});
    let safe=null;
    if(portrait!==null){
      if(typeof portrait!=='string'||portrait.length>200000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(portrait))return res.status(400).json({error:'Portrait JPEG invalide ou trop volumineux.'});
      try{
        const bytes=Buffer.from(portrait.split(',')[1],'base64');
        const converted=await require('sharp')(bytes,{limitInputPixels:16000000}).rotate().resize(256,256,{fit:'cover'}).jpeg({quality:85}).toBuffer();
        safe='data:image/jpeg;base64,'+converted.toString('base64');
      }catch(_){return res.status(400).json({error:'Cette image ne peut pas être lue.'});}
    }
    const result=await pool.query(`INSERT INTO community_followup(phone,portrait) SELECT phone,$2 FROM contacts WHERE phone=$1 ON CONFLICT(phone) DO UPDATE SET portrait=EXCLUDED.portrait RETURNING phone`,[phone,safe]);
    if(!result.rows.length)return res.status(404).json({error:'Contact introuvable. Crée sa fiche avant de lui ajouter un portrait.'});
    res.json({ok:true,portrait:safe});
  }));
  return {ensureDB};
}
module.exports={init};
