// Requiring modules
var slackBotAPI = require('slackbotapi'),
    slack = require('slack-api'),
    Codebase = require('node-codebase'),
    creds = require('./creds.json'),
    _ = require('lodash'),
    os = require('os'),
    logger = require('jethro'),
    logging = true;


// Starting slackbot
var slackBot = new slackBotAPI({
	'token': creds.slack.authToken,
	'logging': logging
});


var outputLog = function(obj) {
    if(logging) {
        logger.output(obj);
    }
}

//process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";


//takes an incoming message, parses ticket number(s)
//in it and sends off message to slack channel with ticket
//details. Then touches the related Codebase ticket(s) with the message from
// slack.
var TicketInfoToPost = function( data ) {
    //are there tickets in this?
    var regex = /(#[0-9\-a-z]*)/g,
        tickets = data.text.match(regex),
        ticketQuery = {},
        ticketProject = '',
        ticketProjectRef = '',
        ticketNum = '',
        channelProject = '';
    if ( ! tickets ) {
        return;
    }
    tickets.forEach( function(ticket){
        /**
         * parse ticket for possible reference
         * infer project to grab ticket details from
         * channel or explicit reference
         * setup ticketQuery(ies) to send in an array and then loop through
         * and get ticket details via codebase api.
         * generate attachment (for each ticket) for posting to slack and
         * send.
         * touch codebase tickets with link to related message triggering
         * that ticket.
         */
        regex = /[#0-9-]/g;
        ticketProjectRef = ticket.replace(regex, '');

        //ensure just ticket num
        regex = /[#a-z-]/g;
        ticketNum = ticket.replace(regex, '');

        //inferred channel project
        channelProject = typeof creds.codebaseMap.channels[data.channel] !== 'undefined' ? creds.codebaseMap.channels[data.channel].projectSlug : creds.codebaseMap.channels.default.projectSlug;

        //if we have a project inferred from ticket use it, otherwise infer
        //from channel.
        ticketProject = ticketProjectRef !== '' ? creds.codebaseMap.projects[ticketProjectRef].projectSlug : channelProject;
        ticketProjectRef = ticketProjectRef === '' ? 'eecore' : ticketProjectRef;

        //ticketQuery
        if ( typeof ticketQuery[ticketProject] !== 'undefined' ) {
            ticketQuery[ticketProject].query += ',' + ticketNum;
        } else {
            ticketQuery[ticketProject] = {};
            ticketQuery[ticketProject].project = ticketProject;
            ticketQuery[ticketProject].projectRef = ticketProjectRef;
            ticketQuery[ticketProject].query = 'id:'+ticketNum
        }
    });
    if ( ticketQuery ) {
        //send ticketQuery for retrieving from codebase and posting to slack
        getAndPostTickets(ticketQuery, data);
    }
};


var getAndPostTickets = function( ticketQuery, data ) {
    var cb = {},
        slattachments = [],
        codebaseMessage = '',
        channelInfo = {};

    //channel info
    slack.channel.info( { "token" : creds.slack.authToken, "channel" : data.channel }, function( slerr, slcdata ) {
        if ( slerr ) {
            console.log( 'Channel Info Error:' );
            console.log( slcdata );
        } else {
            channelInfo = slcdata;
            //loop through ticketQuery and retrieve, then post info related to each ticket
            console.log(ticketQuery);
            cb = new Codebase( creds.codebaseMap.baseEndpoint, creds.codebaseMap.users.eebot.cbAuth.events );
            _.each( ticketQuery, function( queryString, n) {
                console.log(n);
                console.log( queryString );
                cb.tickets.allQuery( queryString.project, { query : queryString.query }, function( cberr, cbdata ) {
                    if ( cberr ) {
                        console.log( 'Error:' );
                        console.log( cbdata );
                        return;
                    } else {
                        //all went well so let's loop through the tickets and grab
                        //the details:
                        if ( cbdata.tickets ) {
                            cbdata.tickets.ticket.forEach( function( ticket ) {
                                slattachments.push({
                                    "fallback" : "Ticket " + ticket.ticketId[0]._ + ': ' + ticket.summary[0],
                                    "color" : creds.codebaseMap.colors[ticket.ticketType[0]] ? creds.codebaseMap.colors[ticket.ticketType[0]] : creds.codebaseMap.colors.default,
                                    "title" : "Ticket: " + ticket.ticketId[0]._ + " (" + ticket.milestone[0].name[0] + ")",
                                    "title_link" : creds.codebaseMap.projects[queryString.projectRef].url + '/tickets/' + ticket.ticketId[0]._,
                                    "text" : "*Ticket Type:* _" + ticket.ticketType[0] + "_ \n" + ticket.summary[0],
                                    "fields" : [
                                        {
                                            "title" : "Priority",
                                            "value" : ticket.priority[0].name[0],
                                            "short" : true
                                        },
                                        {
                                            "title" : "Status",
                                            "value" : ticket.status[0].name[0],
                                            "short" : true
                                        }
                                    ],
                                    "markdwn_in" : ["text","pretext"]
                                });

                                //touch ticket in codebase
                                codebaseMessage = "![enter image description here][1] This ticket was [talked about in Slack][2] \n\n " + data.text + "\n\n [1]: https://events.codebasehq.com/upload/71d24d9a-22da-4a45-1cb4-4da98d6b0974/show/original \n\n[2]: " + creds.slack.archivesEndpoint + channelInfo.channel.name + '/p' + data.ts.replace('.', '');
                                cb.tickets.notes.create( queryString.project, { ticket_id : ticket.ticketId[0]._, content : codebaseMessage }, function( cbterr, cbtdata ) {
                                    if ( cbterr ) {
                                        console.log( 'Codebase ticket update error: ' );
                                        console.log( cbtdata );
                                    }
                                });
                            });

                            slattachments = JSON.stringify( slattachments );
                            console.log( slattachments );
                            //send message to slack
                            slack.chat.postMessage( { token : creds.slack.authToken, text : "", channel : data.channel, attachments : slattachments, as_user : true }, function( slcherr, slchdata ) {
                                if ( slcherr ) {
                                    console.log(slchdata);
                                } else {
                                    outputLog({severity: 'info', source: 'getAndPostTickets', message: 'Sent ticket info to slack', timestamp: new Date(), location: os.hostname() } );
                                }
                            });

                        }
                    }
                });

            });
        }
    });


}

// Slack on EVENT message, send data.
slackBot.on('message', function(data) {
	// If no text, return.
	if(typeof data.text == 'undefined') return;

	// If someone says 'cake!!' respond to their message with "@user OOH, CAKE!! :cake"
	if(data.text === 'cake!!') slackBot.sendMsg(data.channel, "@"+slackBot.getUser(data.user).name+" OOH, CAKE!! :cake:");

    // if the "#[0-9]" is found anywhere in the message look up the ticket.
    TicketInfoToPost( data );

	// If the first character starts with %, you can change this to your own prefix of course.
	if(data.text.charAt(0) === '%') {
		// Split the command and it's arguments into an array
		var command = data.text.substring(1).split(' ');

		// If command[2] is not undefined use command[1] to have all arguments in comand[1]
		if (typeof command[2] != "undefined") {
			for (var i = 2; i < command.length; i++) {
				command[1] = command[1] + ' ' + command[i];
			}
		}

		// Switch to check which command has been requested.
		switch (command[0].toLowerCase()) {
			// If hello
			case "hello":
				// Send message.
				slackBot.sendMsg(data.channel, "Oh, hello @"+slackBot.getUser(data.user).name+" !")
			break;

			case "hue":
				slackBot.sendMsg(data.channel, "@"+slackBot.getUser(data.user).name+" brbrbrbrbrb!")
			break;

			case "say":
				var say = data.text.split('%say ');
				slackBot.sendMsg(data.channel, say[1]);
			break;

            //testing codebase
            case "cbtest":
                var cb = new Codebase( creds.codebaseMap.baseEndpoint, creds.codebaseMap.users.darren.cbAuth.events );
                console.log('got the message');
                cb.tickets.allQuery( 'event-espresso', { query : 'id:1000,1001' }, function( err, cbdata ) {
                    console.log('begin');
                   if ( err ) {
                       console.log('Error:');
                       console.log( cbdata );
                       return;
                   }
                    console.log( cbdata.tickets.ticket[0].status );
                    console.log( cbdata.tickets.ticket[0].priority );
                    console.log( cbdata.tickets.ticket[0].ticketId);
                    console.log( cbdata.tickets.ticket[0].milestone );
                    console.log( cbdata.tickets.ticket );
                    console.log(cbdata);
                });
                break;

			case "debug":
				console.log(slackBot.data.ims);
			break;
		}
	}
});
