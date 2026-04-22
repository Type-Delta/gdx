import litedent from '@/utils/litedent';

/**
 * Builds the comprehensive commit-message generation prompt.
 *
 * @param changesSummary - Summarized staged diff context.
 * @param userDescription - Optional user-provided intent description.
 * @returns Prompt text for LLM completion.
 */
export function commitMsgGenerator(changesSummary: string, userDescription?: string) {
   const userDescriptionBlock = userDescription
      ? litedent`
         <user-change-description>
         User describes the changes as: ${userDescription}
         </user-change-description>` + '\n'
      : '';

   return litedent`
   <instructions>You are an expert Git commit message generator. Analyze the provided git diff in the following messages and generate a concise and informative commit message following the specified format and rules. Focus on clarity and relevance to help maintain a well-documented project history. Output ONLY the commit message.</instructions>

   <rules>
   Commit message must be in the following format:
   \`\`\`
   <type>(<scope>): <title>

   <description>

   <recap>
   \`\`\`

   Where:
   - \`<type>\` is one of the following: feat, fix, docs, style, refactor, test, chore, ci, build, revert
   - \`<scope>\` is a noun describing the section of the codebase affected (e.g., component or file name)
   - \`<title>\` is a short description of the change (max 90 characters)
   - \`<description>\` is a detailed an comprehensive description of the changes
   - \`<recap>\` Only if there are more than two MAJOR changes; bullet points listing important changes

   Additional rules:
   - Use the imperative mood in the title (e.g., "Fix bug" not "Fixed bug" or "Fixes bug")
   - IMPORTANT! Total commit message length MUST NOT EXCEED 170 WORDS, keep it concise
   - Do not use Markdown or any other formatting in the output
   - Do not use bullet points outside of the recap section
   - DO NOT PREFIX SECTIONS with labels like "Description:" or "Recap:"
   </rules>

   ${userDescriptionBlock}
   <git-diff>
   ${changesSummary}
   </git-diff>

   Your commit message:
   `;
}

/**
 * Builds the history-inherited commit-message prompt.
 *
 * @param changesSummary - Summarized staged diff context.
 * @param guideline - Learned repository commit-style guideline.
 * @param userDescription - Optional user-provided intent description.
 * @returns Prompt text for LLM completion.
 */
export function commitMsgGeneratorInherent(
   changesSummary: string,
   guideline: string,
   userDescription?: string
) {
   const userDescriptionBlock = userDescription
      ? litedent`
         <user-change-description>
         User describes the changes as: ${userDescription}
         </user-change-description>` + '\n'
      : '';

   return litedent`
    <instructions>You are an expert Git commit message generator. Analyze the provided git diff and generate a commit message that follows the project-specific conventions documented below. Focus on clarity and consistency with the existing commit history. Output ONLY the commit message.</instructions>

   <project-commit-guidelines>
   ${guideline}
   </project-commit-guidelines>

   <rules>
   - Follow the project-specific conventions above strictly
   - Use the imperative mood in commit titles
   - IMPORTANT! Total commit message length MUST NOT EXCEED 170 WORDS, keep it concise
   - Do not use Markdown or any other formatting in the output
   - Output ONLY the commit message without any labels or prefixes
   </rules>

   ${userDescriptionBlock}
   <git-diff>
   ${changesSummary}
   </git-diff>

   Your commit message:
   `;
}

export function guidelineLearningPrompt(commitMessages: string[]) {
   const nullSeparator = '\x00';
   const examplesText = commitMessages
      .map((msg, i) => `Example ${i + 1}:\n${msg}`)
      .join(nullSeparator);

   return litedent`
   <instructions>You are analyzing a Git repository's commit message history to identify and document the commit message conventions used by this project. Study the provided examples and extract the underlying patterns, structure, and style rules.</instructions>

   <commit-message-examples>
   ${examplesText}
   </commit-message-examples>

   <task>
    Analyze the commit messages above and produce a concise "Commit Message Guideline" document (max 500 words) that captures:
   1. Overall structure (header/body/footer format)
   2. Header conventions (prefixes, types, scopes, title style)
   3. Body conventions (description style, bullets if used)
   4. Any recurring patterns or special formatting

    CRITICAL RULES:
    - Messages are separated by a NULL character (\x00) only as a delimiter; it is not part of any commit message
    - Only document patterns that are CLEARLY EVIDENT in the examples
   - Do NOT invent rules that aren't demonstrated in the actual commits
   - If examples are inconsistent, note the variations
   - Be specific and actionable
   - Don't mention wrapping rules
   - Output ONLY the guideline document, no preamble
   </task>

   Commit Message Guideline:`;
}

export function nocapPrompt(commitMessage: string) {
   return litedent`
   <instruction>
   You are an unfiltered Gen-Z dev who speaks like a terminal meme lord.
   You talk in chaotic, funny, exaggerated internet slang. You sprinkle emojis,
   caps, sarcasm, and over-the-top reactions. Never boring.
   You're reacting to a git commit message and giving a short, witty comment (max 250 chars).
   You may roast, praise, or question the commit — whatever fits the vibe.
   Keep it casual, absurd, Gen-Z, and funny. Pretend it's your homie's commit.
   </instruction>

   <rules>
   - NEVER put hashtags in your comments.
   - Output ONLY the comment.
   </rules>

   <commit>
   ${commitMessage}
   </commit>

   Your unhinged reaction:`;
}
