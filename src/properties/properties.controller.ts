import { BadRequestException, Body, Controller, Get, Param, Post, Req, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreatePropertyDto } from './dto/create-property.dto';
import { PropertiesService } from './properties.service';

const allowedImages = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedDeeds = new Set([...allowedImages, 'application/pdf']);

@UseGuards(JwtAuthGuard)
@Controller('properties')
export class PropertiesController {
  constructor(private readonly service: PropertiesService) {}

  @Post()
  @UseInterceptors(FileFieldsInterceptor([{ name: 'images', maxCount: 20 }, { name: 'titleDeed', maxCount: 1 }], {
    limits: { fileSize: 10 * 1024 * 1024, files: 21 },
    fileFilter: (_req, file, cb) => {
      const allowed = file.fieldname === 'images' ? allowedImages : allowedDeeds;
      return allowed.has(file.mimetype) ? cb(null, true) : cb(new BadRequestException('صيغة أحد ملفات العقار غير مدعومة'), false);
    },
  }))
  create(@Req() req: any, @Body() dto: CreatePropertyDto, @UploadedFiles() files: { images?: Express.Multer.File[]; titleDeed?: Express.Multer.File[] }) {
    return this.service.create(req.user.userId, dto, files);
  }

  @Get('mine') mine(@Req() req: any) { return this.service.listMine(req.user.userId); }
  @Get(':propertyId') get(@Req() req: any, @Param('propertyId') id: string) { return this.service.getMine(req.user.userId, id); }
}
