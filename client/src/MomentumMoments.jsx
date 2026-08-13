/* =========================================================
   MOMENTUM MOMENTS
   ========================================================= */

.momentum-panel {
  margin-top: 24px;
}

.momentum-heading {
  align-items: flex-start;
}

.current-momentum {
  min-width: 150px;
  padding: 16px;
  border-radius: 16px;
  background: var(--panel-soft, #f5f7fa);
  text-align: right;
}

.current-momentum span {
  display: block;
  font-size: 12px;
  color: #6b7280;
}

.current-momentum strong {
  display: block;
  margin-top: 4px;
  font-size: 30px;
}

.moment-feature {
  display: flex;
  gap: 20px;
  align-items: center;
  margin: 20px 0;
  padding: 24px;
  border-radius: 20px;
  border: 1px solid #e5e7eb;
  background: #fafafa;
}

.moment-feature-icon {
  width: 60px;
  height: 60px;
  border-radius: 18px;
  display: grid;
  place-items: center;
  font-size: 30px;
  background: #ffffff;
  flex-shrink: 0;
}

.moment-feature h3 {
  margin: 5px 0 6px;
  font-size: 20px;
}

.moment-feature p {
  margin: 0 0 14px;
  color: #667085;
}

.moment-type {
  display: inline-block;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .06em;
}

.moment-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin: 20px 0 28px;
}

.moment-stats > div {
  padding: 15px;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  background: #fff;
}

.moment-stats span {
  display: block;
  font-size: 12px;
  color: #667085;
}

.moment-stats strong {
  display: block;
  margin-top: 5px;
  font-size: 24px;
}

.timeline-title {
  margin: 10px 0 14px;
}

.moment-timeline {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
}

.moment-card {
  display: flex;
  gap: 14px;
  width: 100%;
  text-align: left;
  padding: 18px;
  border-radius: 18px;
  border: 1px solid #e5e7eb;
  background: #fff;
  cursor: pointer;
  transition: transform .15s ease, box-shadow .15s ease;
}

.moment-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0,0,0,.07);
}

.moment-icon {
  width: 42px;
  height: 42px;
  border-radius: 13px;
  display: grid;
  place-items: center;
  background: #f5f5f5;
  font-size: 21px;
  flex-shrink: 0;
}

.moment-card-content {
  min-width: 0;
}

.moment-card h3 {
  margin: 4px 0;
  font-size: 16px;
}

.moment-card p {
  margin: 0;
  color: #667085;
  font-size: 13px;
}

.moment-change {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 7px;
}

.moment-change strong {
  font-size: 15px;
}

.moment-change em {
  font-size: 12px;
  font-style: normal;
  font-weight: 700;
}

.moment-card small {
  color: #98a2b3;
}

.moment-growth .moment-change em,
.moment-feature.moment-growth .moment-type {
  color: #16803c;
}

.moment-drift .moment-change em,
.moment-feature.moment-drift .moment-type {
  color: #9a6700;
}

.moment-drop .moment-change em,
.moment-feature.moment-drop .moment-type {
  color: #b42318;
}

.moment-recovery .moment-change em,
.moment-feature.moment-recovery .moment-type {
  color: #175cd3;
}

.moment-empty {
  text-align: center;
  padding: 45px 20px;
  color: #667085;
}

.moment-empty > div {
  font-size: 36px;
}

.moment-empty h3 {
  color: #101828;
  margin-bottom: 5px;
}

.moment-loading {
  padding: 35px;
  text-align: center;
  color: #667085;
}

.moment-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(16, 24, 40, .45);
}

.moment-modal {
  width: min(650px, 100%);
  max-height: 90vh;
  overflow-y: auto;
  padding: 26px;
  border-radius: 22px;
  background: #fff;
  box-shadow: 0 24px 70px rgba(0,0,0,.18);
}

.moment-modal-header {
  display: flex;
  justify-content: space-between;
  gap: 20px;
}

.moment-modal-header h2 {
  margin: 7px 0 0;
}

.moment-score-large {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 30px;
  margin: 25px 0;
  padding: 24px;
  border-radius: 18px;
  background: #f8fafc;
}

.moment-score-large div:not(.moment-arrow) {
  text-align: center;
}

.moment-score-large span {
  display: block;
  font-size: 12px;
  color: #667085;
}

.moment-score-large strong {
  display: block;
  margin-top: 5px;
  font-size: 34px;
}

.moment-arrow {
  font-size: 28px;
  color: #98a2b3;
}

.moment-section {
  margin-top: 22px;
}

.moment-section h3 {
  margin-bottom: 7px;
}

.moment-section p {
  color: #475467;
  line-height: 1.6;
}

.moment-factors {
  display: grid;
  gap: 8px;
}

.moment-factor {
  display: flex;
  justify-content: space-between;
  padding: 12px 14px;
  border-radius: 12px;
  background: #f8fafc;
}

.moment-factor span {
  color: #667085;
}

.moment-positive {
  margin-top: 20px;
  padding: 16px;
  border-radius: 14px;
  background: #f0fdf4;
}

.moment-positive p {
  margin: 5px 0 0;
}

.moment-reflection {
  margin-top: 22px;
  padding-top: 20px;
  border-top: 1px solid #eaecf0;
}

.reflection-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.reflection-options button {
  padding: 9px 13px;
  border-radius: 999px;
  border: 1px solid #d0d5dd;
  background: #fff;
  cursor: pointer;
}

.moment-close {
  width: 100%;
  margin-top: 22px;
}

@media (max-width: 700px) {
  .moment-stats {
    grid-template-columns: repeat(2, 1fr);
  }

  .moment-timeline {
    grid-template-columns: 1fr;
  }

  .moment-feature {
    align-items: flex-start;
  }

  .current-momentum {
    min-width: 110px;
  }
}
