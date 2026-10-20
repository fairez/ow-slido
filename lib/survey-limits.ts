/** Kept free of db imports so client components can use them. */
export const SURVEY_MAX_QUESTIONS = 20;
export const SURVEY_MIN_QUESTIONS = 1;
export const SURVEY_QUESTION_MAX = 200;
export const SURVEY_MIN_OPTIONS = 2;
export const SURVEY_MAX_OPTIONS = 10;
export const SURVEY_OPTION_MAX = 80;
export const SURVEY_ANSWER_MAX = 500;
export const SURVEY_KINDS = ["choice", "rating", "openText"] as const;
export type SurveyKind = (typeof SURVEY_KINDS)[number];
