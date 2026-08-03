/**
 * A worked example of the question import format.
 *
 * Kept as data rather than documentation so the admin screen can offer it as
 * a download, and so it stays in step with the schema it illustrates: every
 * field here is one llmQuestionSchema actually accepts.
 *
 * Two questions on purpose - one single-answer, one multi-answer with maths
 * and a diagram - because the interesting mistakes are in the second kind.
 */
export const IMPORT_TEMPLATE = {
  questions: [
    {
      format: 'MCQ_SINGLE',
      subject: 'Science',
      topic: 'Forces',
      subtopic: 'Units',
      difficultyTag: 'easy',
      cognitiveTag: 'memory',
      skillTags: ['factual_gk'],
      estimatedSeconds: 45,
      content: {
        blocks: [{ type: 'text', value: 'What is the SI unit of force?' }],
      },
      options: [
        { id: 'a', blocks: [{ type: 'text', value: 'Joule' }] },
        { id: 'b', blocks: [{ type: 'text', value: 'Newton' }] },
        { id: 'c', blocks: [{ type: 'text', value: 'Watt' }] },
        { id: 'd', blocks: [{ type: 'text', value: 'Pascal' }] },
      ],
      answerKey: { correctOptionId: 'b' },
      explanation: {
        blocks: [{ type: 'text', value: 'Force is measured in newtons: one newton accelerates one kilogram at one metre per second squared.' }],
      },
      imageRequired: false,
    },
    {
      format: 'MCQ_MULTI',
      subject: 'Mathematics',
      topic: 'Quadratic equations',
      difficultyTag: 'moderate',
      cognitiveTag: 'application',
      skillTags: ['algebraic_manipulation', 'numerical_computation'],
      estimatedSeconds: 90,
      content: {
        blocks: [
          { type: 'text', value: 'Which of these are roots of the equation below?' },
          { type: 'math', tex: 'x^2 - 5x + 6 = 0', display: true },
        ],
      },
      options: [
        { id: 'a', blocks: [{ type: 'math', tex: 'x = 1', display: false }] },
        { id: 'b', blocks: [{ type: 'math', tex: 'x = 2', display: false }] },
        { id: 'c', blocks: [{ type: 'math', tex: 'x = 3', display: false }] },
        { id: 'd', blocks: [{ type: 'math', tex: 'x = 6', display: false }] },
      ],
      answerKey: { correctOptionIds: ['b', 'c'] },
      explanation: {
        blocks: [
          { type: 'text', value: 'Factorising gives (x - 2)(x - 3) = 0, so the roots are 2 and 3.' },
          { type: 'math', tex: 'x^2 - 5x + 6 = (x-2)(x-3)', display: true },
        ],
      },
      imageRequired: false,
    },
  ],
};
