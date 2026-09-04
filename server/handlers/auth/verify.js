const {getAdmin,json,requireAuth}=require("../../lib/firebase");
const cors=require("../../lib/cors");
module.exports=async(req,res)=>{
 if(cors(req,res))return;
 try{
  const d=await requireAuth(req);
  const snap=await getAdmin().firestore().collection("users").doc(d.uid).get();
  return json(res,200,{success:true,user:{uid:d.uid,...(snap.exists?snap.data():{})}});
 }catch(e){return json(res,e.status||401,{success:false,error:e.message});}
};
