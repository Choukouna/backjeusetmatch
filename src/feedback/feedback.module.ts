import { Inject } from '@nestjs/common';
import { Controller, Post, Module, Injectable } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { FirebaseService } from '../firebase/firebase.module.js';
import { CurrentUid } from '../auth/auth.guard.js';
import { ApiInput, Input, operationIdSchema } from '../common/http.js';
import { previousOperation, finishOperation } from '../common/operations.js';
const feedbackSchema = z
  .object({
    operationId: operationIdSchema,
    message: z.string().trim().min(1).max(5000),
  })
  .strict();
@Injectable()
class FeedbackService {
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
  ) {}
  async create(uid: string, body: z.infer<typeof feedbackSchema>) {
    const db = this.firebase.db,
      ref = db.collection('user_feedbacks').doc();
    return db.runTransaction(async (tx) => {
      const action = { kind: 'feedback', ...body };
      const previous = await previousOperation(
        tx,
        db,
        uid,
        body.operationId,
        action,
      );
      if (previous) return { id: previous };
      tx.create(ref, {
        userId: uid,
        feedback: body.message,
        createdAt: FieldValue.serverTimestamp(),
      });
      finishOperation(tx, db, uid, body.operationId, action, ref.id);
      return { id: ref.id };
    });
  }
}
@ApiTags('feedback')
@ApiBearerAuth()
@Controller('feedback')
class FeedbackController {
  constructor(
    @Inject(FeedbackService) private readonly feedback: FeedbackService,
  ) {}
  @Post()
  @ApiInput(feedbackSchema)
  create(
    @CurrentUid() uid: string,
    @Input(feedbackSchema) body: z.infer<typeof feedbackSchema>,
  ) {
    return this.feedback.create(uid, body);
  }
}
@Module({ controllers: [FeedbackController], providers: [FeedbackService] })
export class FeedbackModule {}
