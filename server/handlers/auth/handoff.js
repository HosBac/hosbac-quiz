const {getAdmin,json,requireAuth}=require('../../lib/firebase');
const cors=require('../../lib/cors');
module.exports=async(req,res)=>{
  if(cors(req,res)) return;
  if(req.method!=='POST') return json(res,405,{success:false,error:'POST requis'});
  try{
    const decoded=await requireAuth(req);
    const customToken=await getAdmin().auth().createCustomToken(decoded.uid,{hosbac:true});
    return json(res,200,{success:true,customToken,uid:decoded.uid});
  }catch(e){return json(res,e.status||401,{success:false,error:e.message});}
};
