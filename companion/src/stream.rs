use serde_json::{Value, json};
use std::io::BufRead;
use url::Url;

/// Do not accept text deltas as a completed result: plan-usage failures can arrive late.
#[derive(Debug)]
pub struct AnalysisResponse {
    pub text: String,
    pub research: Value,
}

fn add_source(sources: &mut Vec<Value>, url: &str, title: &str) {
    if sources.len() >= 50 || url.len() > 2000 {
        return;
    }
    let Ok(parsed) = Url::parse(url) else {
        return;
    };
    if !matches!(parsed.scheme(), "https" | "http")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return;
    }
    if !sources.iter().any(|source| source["url"] == url) {
        sources.push(json!({"url":url,"title":title.chars().take(300).collect::<String>()}));
    }
}

fn research_item(item: &Value, searched: &mut bool, sources: &mut Vec<Value>) {
    if item["type"] == "web_search_call" && item["status"] == "completed" {
        *searched = true;
        if let Some(values) = item["action"]["sources"].as_array() {
            for source in values {
                if let Some(url) = source["url"].as_str() {
                    add_source(sources, url, source["title"].as_str().unwrap_or_default());
                }
            }
        }
        if let Some(url) = item["action"]["url"].as_str() {
            add_source(sources, url, "");
        }
    }
    if item["type"] == "message"
        && let Some(content) = item["content"].as_array()
    {
        for part in content {
            if let Some(annotations) = part["annotations"].as_array() {
                for annotation in annotations {
                    if annotation["type"] == "url_citation"
                        && let Some(url) = annotation["url"].as_str()
                    {
                        add_source(
                            sources,
                            url,
                            annotation["title"].as_str().unwrap_or_default(),
                        );
                    }
                }
            }
        }
    }
}

/// These codes have distinct recovery paths; never reflect provider messages or private details.
pub fn plan_usage_error(event: &Value) -> Option<&'static str> {
    let code = [&event["response"]["error"], &event["error"], event]
        .iter()
        .find_map(|error| error["code"].as_str());
    match code {
        Some("subscription_sharing_usage_limit_exceeded") => Some(
            "ChatGPT usage for this app has reached its limit. Check ChatGPT Settings → Usage, then retry when usage is available.",
        ),
        Some("subscription_sharing_usage_unavailable") => Some(
            "ChatGPT could not check usage availability. Your connection is still saved; try again later.",
        ),
        _ => None,
    }
}

pub fn read_response(reader: impl BufRead) -> Result<AnalysisResponse, String> {
    let mut text = String::new();
    let mut data = String::new();
    let mut completed = false;
    let mut consumed = 0;
    let mut searched = false;
    let mut sources = Vec::new();
    // Bound the read before allocating a line; checking line length afterwards is too late.
    for line in reader.take(4 * 1024 * 1024 + 1).lines() {
        let line = line.map_err(|_| "The AI response was interrupted.")?;
        consumed += line.len();
        if consumed > 4 * 1024 * 1024 || text.len() > 100_000 {
            return Err("The AI response exceeded the local size limit.".into());
        }
        if line.is_empty() {
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                break;
            }
            let event: Value = serde_json::from_str(&data).map_err(|_| "Invalid AI event.")?;
            data.clear();
            match event["type"].as_str() {
                Some("response.output_text.delta") => {
                    text.push_str(event["delta"].as_str().unwrap_or_default());
                }
                Some("response.output_item.done") => {
                    research_item(&event["item"], &mut searched, &mut sources);
                }
                Some("response.completed") => {
                    if let Some(output) = event["response"]["output"].as_array() {
                        for item in output {
                            research_item(item, &mut searched, &mut sources);
                        }
                    }
                    completed = true;
                    break;
                }
                Some("response.failed" | "response.incomplete" | "error") => {
                    return Err(plan_usage_error(&event).unwrap_or("The provider could not complete this check. Review connection and plan usage.").into());
                }
                _ => {}
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    if !completed || text.trim().is_empty() {
        return Err("The AI stream ended without a completed result.".into());
    }
    Ok(AnalysisResponse {
        text,
        research: json!({"searched": searched, "sources": sources}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn late_failure_invalidates_partial_answer() {
        let stream = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"vegan\"}\n\ndata: {\"type\":\"response.failed\"}\n\n";
        assert!(read_response(Cursor::new(stream)).is_err());
    }

    #[test]
    fn late_plan_errors_discard_deltas_and_explain_recovery_without_private_details() {
        for (code, expected) in [
            (
                "subscription_sharing_usage_limit_exceeded",
                "ChatGPT usage for this app has reached its limit. Check ChatGPT Settings → Usage, then retry when usage is available.",
            ),
            (
                "subscription_sharing_usage_unavailable",
                "ChatGPT could not check usage availability. Your connection is still saved; try again later.",
            ),
        ] {
            for event in [
                json!({"type":"response.failed","response":{"error":{"code":code,"message":"private provider detail"}}}),
                json!({"type":"error","error":{"code":code,"message":"private provider detail"}}),
                json!({"type":"error","code":code,"message":"private provider detail"}),
            ] {
                let stream = format!(
                    "data: {{\"type\":\"response.output_text.delta\",\"delta\":\"partial vegan answer\"}}\n\ndata: {event}\n\n"
                );
                let error = read_response(Cursor::new(stream)).unwrap_err();
                assert_eq!(error, expected);
                assert!(!error.contains("private provider detail"));
                assert!(!error.contains("partial vegan answer"));
            }
        }
        assert_eq!(
            plan_usage_error(
                &json!({"error":{"message":"subscription_sharing_usage_limit_exceeded"}})
            ),
            None
        );
    }

    #[test]
    fn requires_successful_completion() {
        let prefix = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"result\"}\n\n";
        assert!(read_response(Cursor::new(prefix)).is_err());
        let stream = format!("{prefix}data: {{\"type\":\"response.completed\"}}\n\n");
        assert_eq!(read_response(Cursor::new(stream)).unwrap().text, "result");
    }

    #[test]
    fn rejects_oversized_line_and_done_without_completed() {
        assert!(read_response(Cursor::new(vec![b'x'; 4 * 1024 * 1024 + 10])).is_err());
        assert!(read_response(Cursor::new("data: [DONE]\n\n")).is_err());
        let stream = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\ndata: {\"type\":\"response.incomplete\"}\n\n";
        assert!(read_response(Cursor::new(stream)).is_err());
    }
    #[test]
    fn research_metadata_comes_from_completed_tool_output() {
        let event = json!({"type":"response.completed","response":{"output":[
            {"type":"web_search_call","status":"completed","action":{"type":"search","sources":[{"url":"https://maker.example/product"},{"url":"javascript:bad"}]}},
            {"type":"message","content":[{"annotations":[{"type":"url_citation","url":"https://maker.example/product","title":"Product"},{"type":"url_citation","url":"https://other.example/info","title":"Details"}]}]}
        ]}});
        let stream = format!(
            "data: {{\"type\":\"response.output_text.delta\",\"delta\":\"{{}}\"}}\n\ndata: {event}\n\n"
        );
        let result = read_response(Cursor::new(stream)).unwrap();
        assert_eq!(result.research["searched"], true);
        assert_eq!(result.research["sources"].as_array().unwrap().len(), 2);
        let stream = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"{\\\"research\\\":true}\"}\n\ndata: {\"type\":\"response.completed\"}\n\n";
        assert_eq!(
            read_response(Cursor::new(stream)).unwrap().research["searched"],
            false
        );
    }
}
