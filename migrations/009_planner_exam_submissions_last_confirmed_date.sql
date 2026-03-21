-- Add separate column for analytics/UI: the completion date associated with the last confirmed attempt.
ALTER TABLE planner_exam_submissions
  ADD COLUMN last_confirmed_completion_date TEXT;

