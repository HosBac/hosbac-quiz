function cors(req,res){
 const allowed=String(process.env.CORS_ORIGIN||"").split(",").map(x=>x.trim()).filter(Boolean);
 const origin=req.headers?.origin;
 if(origin && allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin",origin);
 res.setHeader("Vary","Origin");
 res.setHeader("Access-Control-Allow-Headers","Authorization, Content-Type, Accept, X-Captcha-Token, X-Hosbac-Handoff");
 res.setHeader("Access-Control-Allow-Methods","GET,POST,PUT,PATCH,DELETE,OPTIONS");
 if(req.method==="OPTIONS"){res.status(204).end();return true;}
 return false;
}
module.exports=cors;
