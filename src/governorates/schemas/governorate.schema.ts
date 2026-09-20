import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'; import { Document, Types } from 'mongoose';
export type GovernorateDocument = Governorate & Document;
@Schema({ timestamps:true, collection:'governorates' }) export class Governorate {
  @Prop({required:true,unique:true,trim:true,lowercase:true,maxlength:50}) code:string;
  @Prop({required:true,trim:true,maxlength:100}) nameAr:string; @Prop({required:true,trim:true,maxlength:100}) nameEn:string;
  @Prop({required:true,trim:true,maxlength:50,default:'location'}) iconKey:string; @Prop({default:true,index:true}) isActive:boolean;
  @Prop({required:true,default:0,index:true}) sortOrder:number; @Prop({type:Types.ObjectId,ref:'User'}) createdBy?:Types.ObjectId;
  @Prop({type:Types.ObjectId,ref:'User'}) updatedBy?:Types.ObjectId; @Prop({default:0,min:0}) usageCount:number;
  @Prop({ type: Object }) mapViewport?: {
    center: { latitude: number; longitude: number };
    bounds: {
      southWest: { latitude: number; longitude: number };
      northEast: { latitude: number; longitude: number };
    };
  };
}
export const GovernorateSchema=SchemaFactory.createForClass(Governorate); GovernorateSchema.index({isActive:1,sortOrder:1,nameAr:1});
