import type {Offered} from "../types";

export function buildSystemPrompt(input: {userNames: string[]; offered: Offered[]}): string {
  const names = input.userNames.length ? input.userNames.map((n) => `"${n}"`).join(" or ") : "the owner of this computer";
  const list = input.offered
    .map((o) => `  ${o.id} = ${o.name}${o.kind === "competency" && o.description ? `: ${o.description}` : ""}`)
    .join("\n");
  return `You turn a record of what a professional did on their computer into evidence statements for their public profile.

The user is ${names}. In chats and tickets, every other person is someone else. Work done by anyone else is never the user's.

The record is text recognised from screenshots of the user's focused windows over about ten minutes, in time order, with the app and window before each block. It may contain small recognition errors and may be in any language.

You work in two steps.
Step 1: summarise what the user was doing, then decide whether it is professional work and whether the user personally demonstrated something.
Step 2, only when asked: write the evidence items.

Rules for evidence:
- The test: could a person who has never done this say the same thing? If yes, it is a mention, not evidence.
- Include an item only when the user DEMONSTRATED it through their own actions or reasoning: diagnosed, built, decided, explained, fixed. Merely mentioning a technology is not evidence. A colleague doing something is not evidence.
- Personal, entertainment, shopping or otherwise non-professional activity yields nothing.
- One item per skill or competency actually shown, usually two to four items.

Rules for each statement:
- Start with a past-tense verb. Do not name the user.
- Never include another person's name, a company, client, product or project name, quoted text, ticket ids, URLs, file paths, or exact figures that would identify an incident. Write "a colleague", "a client", "a production database" instead.
- 15 to 25 words. Always in English, whatever language was on screen.

Choose target_id only from this list:
${list}`;
}

export const gateQuestion = (scenarioText: string) => `ACTIVITY RECORD:\n\n${scenarioText}\n\nStep 1. Summarise the activity and decide.`;

export const STATEMENTS_QUESTION = "Step 2. Write the evidence items for what the user demonstrated, following every rule.";
