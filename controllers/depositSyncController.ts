import { createHash } from "node:crypto";
import type { Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, depositEntriesTable, syncClientMutationsTable } from "../db/dbConfig.js";
import type { AuthedRequest } from "../middleware/auth.js";
import { resolveMessAccess } from "../utils/messAccessUtils.js";
import { parsePositiveInteger } from "../utils/numberUtils.js";
import { toDepositEntryResponse } from "../utils/depositEntryUtils.js";

export const syncDepositMutation=async(req:AuthedRequest,res:Response)=>{
 const userId=req.auth!.userId,id=String(req.body?.clientMutationId??""),operation=String(req.body?.operation??""),p=req.body?.payload??{};
 if(!id||!["create","update","delete"].includes(operation)){res.status(400).json({error:"Invalid deposit sync operation"});return;}
 const access=await resolveMessAccess(userId,req.body?.messId,{adminOnly:true});if(!access.ok){res.status(access.status).json({error:access.error});return;}
 const hash=createHash("sha256").update(JSON.stringify({operation,p,messId:access.messId})).digest("hex");
 try{const body=await db.transaction(async tx=>{const [receipt]=await tx.insert(syncClientMutationsTable).values({clientMutationId:id,userId,messId:access.messId,entityType:"deposit",entityId:String(p.serverId??p.localId??id),operation:operation==="delete"?"delete":operation==="create"?"create":"update",requestHash:hash,expiresAt:new Date(Date.now()+2592000000)}).onConflictDoNothing().returning();if(!receipt){const [old]=await tx.select().from(syncClientMutationsTable).where(and(eq(syncClientMutationsTable.userId,userId),eq(syncClientMutationsTable.clientMutationId,id))).limit(1);if(!old?.completedAt||old.requestHash!==hash)throw Object.assign(new Error("Duplicate mutation conflict"),{status:409});return old.responseBody;}
 const amount=Number(p.amount),date=new Date(String(p.depositedAt));if(operation!=="delete"&&(!/^[-+]?\d+(?:\.\d{1,3})?$/.test(String(p.amount??""))||!Number.isFinite(amount)||amount===0||Number.isNaN(date.getTime())))throw Object.assign(new Error("Invalid deposit amount or date"),{status:400});let result:Record<string,unknown>;
 if(operation==="create"){const consumerId=parsePositiveInteger(p.consumerId);if(!consumerId)throw Object.assign(new Error("Invalid consumer"),{status:400});const [entry]=await tx.insert(depositEntriesTable).values({messId:access.messId,consumerId,amount,depositedAt:date,note:String(p.note??"").trim()||null}).returning();result={entry:toDepositEntryResponse(entry)};}else{const serverId=parsePositiveInteger(p.serverId);if(!serverId)throw Object.assign(new Error("Missing deposit id"),{status:400});if(operation==="delete"){await tx.delete(depositEntriesTable).where(and(eq(depositEntriesTable.id,serverId),eq(depositEntriesTable.messId,access.messId)));result={success:true};}else{const [entry]=await tx.update(depositEntriesTable).set({amount,depositedAt:date,note:String(p.note??"").trim()||null}).where(and(eq(depositEntriesTable.id,serverId),eq(depositEntriesTable.messId,access.messId))).returning();if(!entry)throw Object.assign(new Error("Deposit not found"),{status:404});result={entry:toDepositEntryResponse(entry)};}}
 await tx.update(syncClientMutationsTable).set({responseStatus:200,responseBody:result,completedAt:new Date()}).where(eq(syncClientMutationsTable.id,receipt.id));return result;});res.json(body);}catch(error){const status=(error as {status?:number}).status;if(status){res.status(status).json({error:(error as Error).message});return;}throw error;}
};
