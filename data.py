import requests

route = "91M"
direction = "outbound"
service_type = "1"

print(f"🚌 Fetching names AND live ETAs for Route {route} ({direction})...")
print("⏳ Please wait, mapping data (takes a few seconds)...\n")

# Step 1: Fetch the sequence and stop IDs
route_stop_url = f"https://data.etabus.gov.hk/v1/transport/kmb/route-stop/{route}/{direction}/{service_type}"
route_stops = requests.get(route_stop_url).json().get('data', [])

# Step 2: Fetch ALL live ETAs for Route 91M in one single API call
eta_url = f"https://data.etabus.gov.hk/v1/transport/kmb/route-eta/{route}/{service_type}"
eta_data = requests.get(eta_url).json().get('data', [])

# Step 3: Filter the ETA data. We only want Outbound ('O') and the very next bus (eta_seq: 1)
# We will store this in a dictionary where the key is the Sequence Number (seq)
live_etas = {}
for record in eta_data:
    if record.get('dir') == 'O' and record.get('eta_seq') == 1:
        seq = int(record['seq'])
        live_etas[seq] = {
            'time': record.get('eta'),
            'remark': record.get('rmk_en', '')
        }

# Set up our table header
print(f"{'Seq':<4} | {'English Name':<38} | {'Next ETA'}")
print("-" * 70)

# Step 4: Loop through the stops, get the names, and match the ETA
for item in route_stops:
    seq = int(item.get('seq'))
    stop_id = item.get('stop')
    
    # Get the physical name from the Stop API
    stop_details_url = f"https://data.etabus.gov.hk/v1/transport/kmb/stop/{stop_id}"
    
    try:
        stop_data = requests.get(stop_details_url).json().get('data', {})
        name_en = stop_data.get('name_en', 'Unknown')
        
        # Truncate long names slightly so the terminal table doesn't break
        if len(name_en) > 36:
            name_en = name_en[:33] + "..."
            
        # Match the ETA from our dictionary
        eta_info = live_etas.get(seq, {})
        raw_time = eta_info.get('time')
        remark = eta_info.get('remark', '')
        
        # Format the output cleanly
        if raw_time:
            # Extract just the HH:MM:SS from the ISO timestamp "2026-04-25T16:30:27+08:00"
            time_only = raw_time.split("T")[1].split("+")[0]
            
            # Tag scheduled buses so we know they aren't live GPS predictions
            if "Scheduled" in remark:
                display_eta = f"{time_only} (Sch)"
            else:
                display_eta = time_only
        else:
            display_eta = "No Data / Arrived"
            
        print(f"{seq:<4} | {name_en:<38} | {display_eta}")
        
    except Exception as e:
        print(f"{seq:<4} | Error processing Stop ID {stop_id}: {e}")

print("\n✅ Finished compiling real-time route dashboard!")