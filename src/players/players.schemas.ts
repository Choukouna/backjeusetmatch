import { z } from 'zod';
export const rankSchema = z.string().regex(/^(NC|[+-]?\d{1,2}(?:\/\d{1,2})?)$/);
export const profileSchema = z
  .object({
    rank: rankSchema,
    city: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .transform((v) => v.toLowerCase()),
    deptCode: z.string().regex(/^(\d{2,3}|2A|2B)$/),
    playsTennis: z.boolean(),
    playsPadel: z.boolean(),
    notificationFrequency: z.enum(['2h', '6h', 'daily', 'never']),
  })
  .strict();
export const registrationSchema = profileSchema
  .extend({
    pseudo: z
      .string()
      .trim()
      .min(6)
      .max(40)
      .regex(/^[\p{L}\p{N}_-]+$/u)
      .transform((v) => v.toLowerCase()),
    name: z.string().trim().min(1).max(100),
    lastname: z.string().trim().min(1).max(100),
  })
  .strict();
export const loginSchema = z
  .object({
    pseudo: z
      .string()
      .trim()
      .min(6)
      .max(40)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(1).max(4096),
  })
  .strict();
export const signupSchema = registrationSchema
  .extend({
    email: z.email().transform((v) => v.toLowerCase()),
    password: z.string().min(6).max(4096),
  })
  .strict();
export type Profile = z.infer<typeof profileSchema>;
export type Registration = z.infer<typeof registrationSchema>;
