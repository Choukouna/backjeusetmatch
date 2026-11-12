import { Inject } from '@nestjs/common';
import {
  Controller,
  Get,
  Patch,
  Put,
  Delete,
  Module,
  Query,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUid, Public } from '../auth/auth.guard.js';
import {
  ApiInput,
  ApiQueries,
  Input,
  ResourceId,
  pageSchema,
} from '../common/http.js';
import { FirebaseService } from '../firebase/firebase.module.js';
import { fields, paginate } from '../firebase/repository.js';
import { PlayersRepository } from './players.repository.js';
import { profileSchema, type Profile } from './players.schemas.js';
const discoverySchema = pageSchema.extend({
  deptCode: z.string().min(2).max(3),
  city: z.string().trim().max(120).optional(),
});
const tokenSchema = z.object({ token: z.string().min(1).max(4096) }).strict();
@ApiTags('players')
@ApiBearerAuth()
@Controller('players')
class PlayersController {
  constructor(
    @Inject(PlayersRepository) private readonly players: PlayersRepository,
  ) {}
  @Get('me') me(@CurrentUid() uid: string) {
    return this.players.get(uid, true);
  }
  @Patch('me')
  @ApiInput(profileSchema)
  update(@CurrentUid() uid: string, @Input(profileSchema) body: Profile) {
    return this.players.update(uid, body);
  }
  @Get() @ApiQueries(discoverySchema) discover(
    @Query({ schema: discoverySchema }) query: z.infer<typeof discoverySchema>,
  ) {
    return this.players.discover(query.deptCode, query.city, query);
  }
  @Get('by-pseudo/:pseudo') byPseudo(
    @Param('pseudo', { schema: z.string().trim().min(1).max(40) })
    pseudo: string,
  ) {
    return this.players.byPseudo(pseudo);
  }
  @Get(':id') get(@ResourceId() id: string, @CurrentUid() uid: string) {
    return this.players.get(id, id === uid);
  }
  @Post('me/opened') opened(@CurrentUid() uid: string) {
    return this.players.touch(uid);
  }
  @Put('me/device-token')
  @ApiInput(tokenSchema)
  token(
    @CurrentUid() uid: string,
    @Input(tokenSchema) body: z.infer<typeof tokenSchema>,
  ) {
    return this.players.deviceToken(uid, body.token, false);
  }
  @Delete('me/device-token')
  @ApiInput(tokenSchema)
  removeToken(
    @CurrentUid() uid: string,
    @Input(tokenSchema) body: z.infer<typeof tokenSchema>,
  ) {
    return this.players.deviceToken(uid, body.token, true);
  }
}
const communeQuery = pageSchema.extend({
  departmentCode: z.string().min(2).max(3).optional(),
  q: z
    .string()
    .trim()
    .min(3)
    .max(100)
    .transform((v) => v.toLowerCase())
    .optional(),
});
@ApiTags('communes')
@Public()
@Controller('communes')
class CommunesController {
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
  ) {}
  @Get() @ApiQueries(communeQuery) list(
    @Query({ schema: communeQuery }) query: z.infer<typeof communeQuery>,
  ) {
    const collection = this.firebase.db.collection('communes');
    let filtered = query.departmentCode
      ? collection.where('departmentCode', '==', query.departmentCode)
      : collection;
    if (query.q)
      filtered = filtered
        .where('nameNormalized', '>=', query.q)
        .where('nameNormalized', '<=', `${query.q}\uf8ff`)
        .orderBy('nameNormalized');
    return paginate(
      filtered,
      query,
      (d, id) => ({
        id,
        ...fields(d, [
          'nameNormalized',
          'departmentCode',
          'postalCodes',
          'code',
        ]),
      }),
      `communes:${query.departmentCode ?? ''}:${query.q ?? ''}`,
      query.q ? collection.path : undefined,
    );
  }
}
@Module({
  controllers: [PlayersController, CommunesController],
  providers: [PlayersRepository],
  exports: [PlayersRepository],
})
export class PlayersModule {}
