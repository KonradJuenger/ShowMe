import { z } from "zod";

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);

export const uid = () => crypto.randomUUID();
