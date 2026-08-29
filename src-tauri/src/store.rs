//! 备忘录与计划安排的加载与持久化。
//!
//! 对应 Python 版 memo_store.py / plan_store.py：变长的结构化数据单独存
//! JSON（memos.json / plans.json，与 config.txt 同目录），不掺进 key=value
//! 的配置文本。读取时逐条收敛，保证调用方拿到的每条都能直接用。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::config::ConfigState;

// 与 Python 版一致的限制：文案长度与条数上限。
pub const MEMO_TEXT_MAX: usize = 200;
pub const MEMO_MAX_COUNT: usize = 50;
pub const PLAN_TITLE_MAX: usize = 40;
pub const PLAN_MAX_COUNT: usize = 50;

/// 计划的手动状态集合；空字符串表示「自动」，按时间推导。
const PLAN_STATUSES: &[&str] = &["todo", "active", "done", "canceled"];

#[derive(Serialize, Deserialize, Clone)]
pub struct Memo {
    pub id: i64,
    pub text: String,
    pub done: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Plan {
    pub id: i64,
    pub title: String,
    pub start: String,
    pub end: String,
    pub status: String,
}

/// JSON 文件与 config.txt 放同一目录（同一套「运行目录」约定）。
fn data_path(state: &ConfigState, file: &str) -> PathBuf {
    state
        .data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(file)
}

/// 读 JSON 文件，缺失或损坏时返回空列表（按 serde_json::Value 解析，
/// 结构不对就当没有数据，不让坏文件把启动卡死）。
fn read_json_array(path: &PathBuf) -> Vec<serde_json::Value> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(serde_json::Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

fn write_json(path: &PathBuf, value: &serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| format!("写入失败: {e}"))
}

/// 取下一个可用 id，始终比现有最大值大一。
fn next_id<T, F>(items: &[T], id_of: F) -> i64
where
    F: Fn(&T) -> i64,
{
    items.iter().map(id_of).max().unwrap_or(0) + 1
}

/// 从原始 JSON 里取整数 id：数字或数字字符串都认，非法时返回 0。
fn raw_id(item: &serde_json::Value) -> i64 {
    match item.get("id") {
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(serde_json::Value::String(s)) => s.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

fn as_str(item: &serde_json::Value, key: &str) -> Option<String> {
    match item.get(key) {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 备忘录
// ---------------------------------------------------------------------------

/// 把单条原始数据收敛成合法条目，无法使用时返回 None。
/// 文案可以是多行的：换行统一成 \n，超长按字符数截断。
fn normalize_memo(item: &serde_json::Value, used_ids: &[i64]) -> Option<Memo> {
    let mut text = as_str(item, "text")?;
    text = text.replace("\r\n", "\n").replace('\r', "\n");
    text = text.trim().chars().take(MEMO_TEXT_MAX).collect();
    if text.is_empty() {
        return None;
    }

    let mut id = raw_id(item);
    // id 缺失、非法或与前面的条目重复时另分配一个，避免编辑时张冠李戴。
    if id <= 0 || used_ids.contains(&id) {
        id = used_ids.iter().copied().max().unwrap_or(0) + 1;
    }
    let done = item
        .get("done")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Some(Memo { id, text, done })
}

fn normalize_memos(raw: Vec<serde_json::Value>) -> Vec<Memo> {
    let mut memos: Vec<Memo> = Vec::new();
    let mut used_ids: Vec<i64> = Vec::new();
    for item in raw {
        let Some(memo) = normalize_memo(&item, &used_ids) else {
            continue;
        };
        used_ids.push(memo.id);
        memos.push(memo);
        if memos.len() >= MEMO_MAX_COUNT {
            break;
        }
    }
    memos
}

fn memos_to_json(memos: &[Memo]) -> serde_json::Value {
    serde_json::to_value(memos).unwrap_or(serde_json::Value::Array(Vec::new()))
}

#[tauri::command]
pub fn load_memos(state: State<ConfigState>) -> Vec<Memo> {
    normalize_memos(read_json_array(&data_path(&state, "memos.json")))
}

/// 保存并返回收敛后的列表：截断、id 去重都在这里落定，前端直接用返回值。
#[tauri::command]
pub fn save_memos(state: State<ConfigState>, memos: Vec<Memo>) -> Result<Vec<Memo>, String> {
    let raw: Vec<serde_json::Value> = memos
        .into_iter()
        .map(|m| serde_json::to_value(m).unwrap_or_default())
        .collect();
    let normalized = normalize_memos(raw);
    write_json(&data_path(&state, "memos.json"), &memos_to_json(&normalized))?;
    Ok(normalized)
}

/// 取下一个可用备忘录 id（前端新增前调用，与 Python 版 next_memo_id 一致）。
#[tauri::command]
pub fn next_memo_id(state: State<ConfigState>) -> i64 {
    let memos = normalize_memos(read_json_array(&data_path(&state, "memos.json")));
    next_id(&memos, |m| m.id)
}

// ---------------------------------------------------------------------------
// 计划安排
// ---------------------------------------------------------------------------

/// 校验存储格式 `YYYY-MM-DD HH:mm` 的定长文本：合法返回 true。
/// 与 Python 版 strptime 的严格口径一致（不足位补零的写法才算数）。
fn valid_time_text(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() != 16 || b[4] != b'-' || b[7] != b'-' || b[10] != b' ' || b[13] != b':' {
        return false;
    }
    let digit = |i: usize| b[i].is_ascii_digit();
    let digits = |r: std::ops::Range<usize>| r.clone().all(|i| digit(i));
    if !digits(0..4) || !digits(5..7) || !digits(8..10) || !digits(11..13) || !digits(14..16) {
        return false;
    }
    let month: u32 = text[5..7].parse().unwrap_or(0);
    let day: u32 = text[8..10].parse().unwrap_or(0);
    let hour: u32 = text[11..13].parse().unwrap_or(0);
    let minute: u32 = text[14..16].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day) && hour <= 23 && minute <= 59
}

/// 排序键：有开始时间按开始时间，只有结束时间的按结束时间。
/// 时间是定长文本，字符串序即时间序；时间相同时按 id 排，顺序才稳定。
fn plan_sort_key(plan: &Plan) -> (String, i64) {
    let time = if plan.start.is_empty() {
        plan.end.as_str()
    } else {
        plan.start.as_str()
    };
    (time.to_string(), plan.id)
}

fn normalize_plan(item: &serde_json::Value, used_ids: &[i64]) -> Option<Plan> {
    let mut title = as_str(item, "title")?;
    // 事项只占一行，换行没有意义，连同连续空白一起压成单个空格。
    title = title.split_whitespace().collect::<Vec<&str>>().join(" ");
    title = title.chars().take(PLAN_TITLE_MAX).collect();
    if title.is_empty() {
        return None;
    }

    // 时间格式非法视为未填；开始与结束至少要有一个，
    // 两个都没有时状态无从推导，也没有排序依据。
    let start = as_str(item, "start").filter(|s| valid_time_text(s));
    let end = as_str(item, "end").filter(|s| valid_time_text(s));
    if start.is_none() && end.is_none() {
        return None;
    }

    // 认不出的状态回落成「自动」，而不是丢掉整条。
    let status = match as_str(item, "status") {
        Some(s) if PLAN_STATUSES.contains(&s.as_str()) => s,
        _ => String::new(),
    };

    let mut id = raw_id(item);
    if id <= 0 || used_ids.contains(&id) {
        id = used_ids.iter().copied().max().unwrap_or(0) + 1;
    }
    Some(Plan {
        id,
        title,
        start: start.unwrap_or_default(),
        end: end.unwrap_or_default(),
        status,
    })
}

fn normalize_plans(mut raw: Vec<serde_json::Value>) -> Vec<Plan> {
    let mut plans: Vec<Plan> = Vec::new();
    let mut used_ids: Vec<i64> = Vec::new();
    for item in raw.drain(..) {
        let Some(plan) = normalize_plan(&item, &used_ids) else {
            continue;
        };
        used_ids.push(plan.id);
        plans.push(plan);
        if plans.len() >= PLAN_MAX_COUNT {
            break;
        }
    }
    // 改了时间排序就会变，先排好再落盘，文件本身也保持有序。
    plans.sort_by(|a, b| plan_sort_key(a).cmp(&plan_sort_key(b)));
    plans
}

#[tauri::command]
pub fn load_plans(state: State<ConfigState>) -> Vec<Plan> {
    normalize_plans(read_json_array(&data_path(&state, "plans.json")))
}

/// 保存（含排序）并返回收敛后的列表。
#[tauri::command]
pub fn save_plans(state: State<ConfigState>, plans: Vec<Plan>) -> Result<Vec<Plan>, String> {
    let raw: Vec<serde_json::Value> = plans
        .into_iter()
        .map(|p| serde_json::to_value(p).unwrap_or_default())
        .collect();
    let normalized = normalize_plans(raw);
    write_json(
        &data_path(&state, "plans.json"),
        &serde_json::to_value(&normalized).unwrap_or(serde_json::Value::Array(Vec::new())),
    )?;
    Ok(normalized)
}

/// 取下一个可用计划 id。
#[tauri::command]
pub fn next_plan_id(state: State<ConfigState>) -> i64 {
    let plans = normalize_plans(read_json_array(&data_path(&state, "plans.json")));
    next_id(&plans, |p| p.id)
}
