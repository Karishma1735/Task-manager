import { ok, route } from "@/lib/api";

export const GET = route(["owner", "reviewer"], ({ actor }) => ok({ user: actor }));
